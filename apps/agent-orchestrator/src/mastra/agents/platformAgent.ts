import { Agent } from '@mastra/core/agent'
import { RequestContext } from '@mastra/core/request-context'
import { createTool } from '@mastra/core/tools'
import { ModerationProcessor, PIIDetector, PromptInjectionDetector, StreamErrorRetryProcessor, SystemPromptScrubber } from '@mastra/core/processors'
import { MCPClient } from '@mastra/mcp'
import { z } from 'zod'
import { Exa as ExaClass } from 'exa-js'
import pg from 'pg'

import { platformModel, liteModel, privateModel } from '../model.js'
import { SKILL_CONTENT_QUALITY_BAR } from '../../skills/generationPrompt.js'
import { selectModel } from './modelSelection.js'
import type { TenantContext } from '../context.js'
import { getOlmoMemory } from '../memory.js'
import { fetchAttachedSkills, fetchTestSkill, fetchInvokedSkills } from '../../usage.js'
import { invokedSkillsInstruction, mergeSkillSets } from '../skillInvocation.js'
import { getMCPClientForTenant } from '../tools.js'
import { isComposioEnabled, getComposioTools } from '../composio.js'
import { createViolationHandler } from '../guardrails.js'
import { makeAppPool } from '../../db.js'
import { retrieveDocumentsTool } from '../tools/retrieveDocuments.js'
import { retrieveTemplate } from '../tools/retrieveTemplate.js'
import { listFolderTool } from '../tools/listFolder.js'
import { findInFolderTool } from '../tools/findInFolder.js'
import { readFileTool } from '../tools/readFile.js'
import { platformCapabilityTools } from '../tools/platform-capabilities.js'
import { askClarifyingQuestionsTool } from '../tools/askClarifyingQuestions.js'
import { requestUploadTool } from '../tools/requestUpload.js'
import { renderCanvas } from '../tools/renderCanvas.js'
import { analyzeAudioTool } from '../tools/analyzeAudio.js'
import { analyzeVideoTool } from '../tools/analyzeVideo.js'
import { draftSkillTool } from '../tools/draftSkill.js'
import { saveSkillTool } from '../tools/saveSkill.js'
import { buildOlmoDelegates } from './olmoDelegates.js'

// ---------------------------------------------------------------------------
// Platform prompt — fetched from agentTemplates at request time.
// Queries the latest published template; falls back to static string on error.
// Uses a dedicated small pool — separate from the Mastra internal pool.
// ---------------------------------------------------------------------------

let platformPool: pg.Pool | null = null

function getPlatformPool(): pg.Pool {
  if (!platformPool) {
    platformPool = makeAppPool(2)
    platformPool.on('error', (err) => {
      console.error('[mastra:platform] pool error:', err.message)
    })
  }
  return platformPool
}

// Prompt cache — avoids a DB round-trip on every message.
// TTL: 5 minutes. Invalidated on relay restart.
let _promptCache: { prompt: string; expiresAt: number } | null = null
const PROMPT_CACHE_TTL_MS = 5 * 60 * 1000

async function fetchPlatformPrompt(): Promise<string> {
  if (_promptCache && _promptCache.expiresAt > Date.now()) return _promptCache.prompt
  try {
    const res = await getPlatformPool().query<{ system_prompt: string }>(
      `SELECT system_prompt FROM agent_templates
       WHERE status = 'published'
       ORDER BY version DESC
       LIMIT 1`
    )
    const prompt = res.rows[0]?.system_prompt
    if (prompt) {
      _promptCache = { prompt, expiresAt: Date.now() + PROMPT_CACHE_TTL_MS }
      return prompt
    }
  } catch (err) {
    console.warn('[mastra:platform] fetchPlatformPrompt DB error:', (err as Error).message)
  }
  const fallback = 'You are Olmo, a helpful AI assistant.'
  _promptCache = { prompt: fallback, expiresAt: Date.now() + PROMPT_CACHE_TTL_MS }
  return fallback
}

// ---------------------------------------------------------------------------
// SERVER_TOOLS — real function-call implementations executed by Mastra.
// Named 'internet_search' (not 'web_search') to avoid Vertex AI reserved name
// conflict; 'web_search' as a functionDeclaration triggers native Search tool
// behavior which is incompatible with responseSchema/structured output.
// ---------------------------------------------------------------------------

// Lazy — avoids crash at module load when EXA_API_KEY is not set.
let _exa: ExaClass | null = null
function getExa(): ExaClass {
  if (!_exa) {
    if (!process.env.EXA_API_KEY) throw new Error('EXA_API_KEY is not configured')
    _exa = new ExaClass(process.env.EXA_API_KEY)
  }
  return _exa
}

export const SERVER_TOOLS = {
  // RAG over the tenant's own uploaded corpus. Seeded prompts instruct agents to
  // "always call retrieve_documents"; without this registration that instruction
  // referred to a tool that did not exist and retrieval silently never ran.
  retrieve_documents: retrieveDocumentsTool,
  retrieve_template: retrieveTemplate,
  // start_task / get_task_thread — in-process calls into the shared
  // agent-platform MCP tool registry (no MCP protocol, no network hop). The
  // human/session caller carries no agentId, so Task 4's agent_tool_assignments
  // gate never applies here; access is checked purely on role permission.
  ...platformCapabilityTools,
  internet_search: createTool({
    id: 'internet_search',
    description:
      'Search the internet for current information, news, facts, jobs, and real-time data.',
    inputSchema: z.object({
      query: z.string().describe('The search query'),
    }),
    execute: async (inputData) => {
      const { query } = inputData
      const { results } = await getExa().searchAndContents(query, {
        livecrawl: 'always',
        numResults: 5,
        text: { maxCharacters: 3000 },
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return results.map((r: any) => ({
        title: r.title ?? null,
        url: r.url,
        content: (r.text ?? '').slice(0, 3000),
        publishedDate: r.publishedDate,
      }))
    },
  }),
  web_fetch: createTool({
    id: 'web_fetch',
    description: 'Fetch the content of a URL and return it as text.',
    inputSchema: z.object({
      url: z.string().describe('The URL to fetch'),
    }),
    execute: async (inputData) => {
      const { url } = inputData
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 10_000)
        let response: Response
        try {
          response = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Saarthi/1.0)' },
          })
        } finally {
          clearTimeout(timer)
        }
        if (!response.ok) {
          return { content: '', url, success: false as const, error: `HTTP ${response.status}` }
        }
        const raw = await response.text()
        const text = raw
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/\s{2,}/g, ' ')
          .trim()
          .slice(0, 5000)
        return { content: text, url, success: true as const }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { content: '', url, success: false as const, error: message }
      }
    },
  }),
  ask_clarifying_questions: askClarifyingQuestionsTool,
  request_upload: requestUploadTool,
  render_canvas: renderCanvas,
  analyze_audio: analyzeAudioTool,
  analyze_video: analyzeVideoTool,
  // Two-step, user-triggered only — the tool descriptions tell the model
  // never to call either on its own initiative. draft_skill has no approval
  // gate (nothing to show yet); save_skill does. See saveSkill.ts for the
  // confirm-gate and tenantId/userId/agentId/conversationId provenance rules.
  draft_skill: draftSkillTool,
  save_skill: saveSkillTool,
  // Folder scope: the agent is granted a handle to a folder, not its contents.
  // list_folder is the manifest — names and types only, no bytes read.
  list_folder: listFolderTool,
  // Routes to files, never answers — returns a ranked list so the agent spends
  // one read on the right file instead of pulling the folder into context.
  find_in_folder: findInFolderTool,
  // Reads one file, enforced against the grant before a byte is fetched.
  read_file: readFileTool,
}

// Server tool names used to filter out duplicate MCP tool registrations.
// 'web_search' is blocked because we expose it as 'internet_search' via Exa.
// 'create_plan_from_prd' is blocked because the agent must never call it —
// plan creation is user-triggered via the PlanCard "Create in System" button.
const SERVER_TOOL_NAMES = new Set([...Object.keys(SERVER_TOOLS), 'web_search', 'create_plan_from_prd'])

// MCP tool cache — avoids reconnecting to mcp-server on every message.
// TTL: 60 seconds per tenant.
const MCP_TOOLS_CACHE_TTL_MS = 5 * 60_000 // 5 minutes
const mcpToolsCache = new Map<string, { tools: Record<string, any>; expiresAt: number }>()

async function getCachedMcpTools(mcpClient: MCPClient, tenantId: string): Promise<Record<string, any>> {
  const cached = mcpToolsCache.get(tenantId)
  if (cached && cached.expiresAt > Date.now()) return cached.tools
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tools: Record<string, any> = {}
  try {
    tools = await mcpClient.listTools()
    mcpToolsCache.set(tenantId, { tools, expiresAt: Date.now() + MCP_TOOLS_CACHE_TTL_MS })
    console.log('[mastra] mcpToolsCache miss — fetched', Object.keys(tools).length, 'tools for tenant', tenantId)
  } catch (err) {
    console.warn('[mastra] listTools failed, continuing without MCP tools:', (err as Error).message)
  }
  return tools
}

// ---------------------------------------------------------------------------
// Guardrail processors — run on every message, input and output.
// strategy: 'warn' in demo/dev — logs violations but does not block.
// Switch to 'block' in production to hard-reject violating content.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyProcessor = { onViolation?: (v: any) => void }

const violationHandler = createViolationHandler()

const promptInjectionDetector = new PromptInjectionDetector({
  model: liteModel,
  strategy: 'warn',
  threshold: 0.7,
  lastMessageOnly: true,
})
;(promptInjectionDetector as AnyProcessor).onViolation = violationHandler

const moderationProcessor = new ModerationProcessor({
  model: liteModel,
  strategy: 'warn',
  threshold: 0.5,
  lastMessageOnly: true,
})
;(moderationProcessor as AnyProcessor).onViolation = violationHandler

const piiDetector = new PIIDetector({
  model: liteModel,
  strategy: 'redact',
  redactionMethod: 'placeholder',
  lastMessageOnly: true,
})
;(piiDetector as AnyProcessor).onViolation = violationHandler

const systemPromptScrubber = new SystemPromptScrubber({
  model: liteModel,
})
;(systemPromptScrubber as AnyProcessor).onViolation = violationHandler

// ---------------------------------------------------------------------------
// One platform Agent — serves all tenants.
//
// instructions: dynamic — fetches latest published agentTemplate from DB.
// tools:        dynamic — builds per-request MCPClient from requestContext.
//               Falls back to SERVER_TOOLS when requestContext has no tenantId
//               (e.g., during tool discovery calls from Mastra Studio).
// memory:       getOlmoMemory() — Olmo's OWN instance, not the shared
//               getMastraMemory() singleton. Same storage/vector/embedder, but
//               thread-scoped recall and working memory, which is what keeps
//               delegated sub-agent calls from becoming a cross-tenant read
//               channel. See getOlmoMemory()'s note in memory.ts.
// model:        AI SDK connector routes through Inference Gateway at INFERENCE_GATEWAY_URL.
// ---------------------------------------------------------------------------

// draft_skill/save_skill's own descriptions already say what they need — this
// restates it as a hard rule because the model has ask_clarifying_questions
// available too, and nothing else stops it from using that tool to push raw
// SKILL.md/YAML authorship onto the user instead of drafting it. A
// non-technical user asked to hand-write frontmatter is a broken, scary
// interaction, not a legitimate clarification.
//
// Shared with SKILL_CONTENT_QUALITY_BAR (skills/generationPrompt.ts) — kept
// for now as the one other place this bar is asserted, though its own
// SKILL_SYSTEM_PROMPT/buildSkillPrompt caller (the old dashboard "Create
// skill" modal) no longer exists in the web app.
export const SKILL_CREATION_CONTRACT = `\n\n## Skill creation — required behaviour
When the user asks to create or save a skill:
1. Get a NAME from the user first. Never invent one yourself — if they haven't given one, ask (via ask_clarifying_questions or directly).
2. Gather a BRIEF — what the skill should teach an agent — via ask_clarifying_questions if they haven't already given you enough. NEVER ask the user to write or paste SKILL.md/YAML content themselves; that is draft_skill's job, not theirs.
3. Call draft_skill with the name and the full brief. It drafts and validates the SKILL.md itself — you do not write the description or body by hand.
4. Show the user the returned draft. Only after they approve (or ask for it to be saved) do you call save_skill with that same name/description/body — never an unreviewed draft, never one you rewrote yourself.

## Skill content quality — required behaviour
${SKILL_CONTENT_QUALITY_BAR}`

export const platformAgent = new Agent({
  id: 'olmo',
  name: 'Olmo',

  instructions: async ({ requestContext }: { requestContext?: RequestContext<TenantContext> }) => {
    // Per-agent override takes precedence over the global agent_templates prompt.
    // Set by chatStream.ts from agentSkills.systemPrompt before calling stream().
    // PRD generation is handled by prdWorkflow (gatherStep → writeStep → formatStep).
    const override = requestContext?.get('agentSystemPrompt') as string | undefined
    const base = override ?? await fetchPlatformPrompt()
    // Persona personality is a layer composed ahead of the base prompt, never a
    // replacement for it — an agent with a persona keeps 100% of its normal
    // capabilities, just with a personality prepended. Set by chatStream.ts from
    // agentPersonas.basePersonality.
    const persona = requestContext?.get('personaPersonality') as string | undefined
    const composed = persona ? `${persona}\n\n${base}` : base
    // Hardcoded tool-usage contract — appended to every prompt path (DB template,
    // per-agent override, persona) so no variant can silently drop this rule.
    const CLARIFICATION_CONTRACT = `\n\n## Clarifying questions — required behaviour
ALWAYS call the ask_clarifying_questions tool whenever you need more information before proceeding. This applies to:
- The first time you need clarification on a request.
- Every subsequent round of follow-up questions, no matter how many rounds that takes.
NEVER write a clarifying question as plain prose, a bulleted list, or any other text in your reply. If you have a question, call the tool. If you write questions as text instead of calling the tool, the user cannot answer them interactively and the conversation will break.`
    const CODE_BLOCK_CONTRACT = `\n\n## Code formatting — required behaviour
ALWAYS specify the language identifier on every fenced code block. Examples: \`\`\`python, \`\`\`typescript, \`\`\`bash, \`\`\`sql, \`\`\`json, \`\`\`yaml.
NEVER write a fenced code block with no language tag (i.e. never use a bare \`\`\` with nothing after it). If you are genuinely unsure of the language, use \`\`\`text as a fallback.`
    const CANVAS_CONTRACT = `\n\n## Canvas output — required behaviour
Whenever your response contains structured or long-form content — analyses, comparisons, plans, summaries, reports, code explanations, tables, step-by-step guides, or anything exceeding roughly 200 words — you MUST call the render_canvas tool with the full markdown content BEFORE writing your reply in chat.
- Set title to a short, descriptive label (e.g. "Q3 Competitive Analysis", "Onboarding Plan").
- Set type to "document" unless the content is specifically a PRD ("prd"), roadmap ("roadmap"), or task list ("tasks").
- Your chat reply should then be a brief 1–3 sentence summary pointing the user to the canvas, NOT a repeat of the full content.
For short conversational answers or simple one-liners, do NOT call render_canvas.

After retrieve_documents returns content: you MUST call render_canvas with a structured summary or analysis of that content in the SAME response. Do not acknowledge the document and wait — produce the output immediately.

NEVER claim to have called render_canvas unless you actually called it in this response. If you did not call render_canvas, do not say "I sent it to the canvas", "I rendered a summary", or anything implying you did. If you realise you forgot to render something, call render_canvas now instead of defending a claim you cannot back up.`
    // Base/persona prompts describe what the agent does, not who it is when asked
    // point-blank — "who are you" / "what model are you" otherwise falls through
    // to the underlying model's own trained self-disclosure (e.g. Gemini stating
    // it was trained by Google), even with a persona or base prompt composed in.
    // Appended last, same as the other contracts, so it can't be dropped by a
    // thin fallback prompt or a persona that doesn't cover identity questions.
    const IDENTITY_CONTRACT = `\n\n## Identity — required behaviour
When asked who you are, what you are, what model or company built you, or similar identity questions, answer as ${(requestContext?.get('agentName') as string | undefined) || 'Olmo'} — the persona/system prompt above, not the underlying model provider. NEVER say you are a large language model trained by Google, OpenAI, Anthropic, or any other provider, and never name the underlying model.`
    const DELEGATION_CONTRACT = `\n\n## Delegation — required behaviour
When delegating to a sub-agent (agent-director, agent-pm, agent-architect, agent-producer), ALWAYS call one sub-agent at a time — never make more than one sub-agent call in the same response. If a task requires multiple outputs (e.g. two images, two formats), call the sub-agent once, wait for the result, then call it again for the next output.

## Delegate media results — required behaviour
When you call agent-director (image/video) or agent-producer (audio) and get a result back, DO NOT claim any media was produced unless the delegate's result contains a subAgentToolResults entry with an actual fileId — a persisted attachment. The delegate's plain \`text\` field is narrative only; it can describe an intended image without any image having been created. If you see no fileId in subAgentToolResults, treat the delegate as having produced nothing: tell the user the media couldn't be generated this time and offer to retry, DO NOT say "the image is above" or "attached" or "generated in the previous step" — the UI will not render anything and the user will see nothing. This rule applies regardless of what the delegate's text claims.`
    // Neither buildPlatformPrompt()'s DB-stored base ("answer from documents
    // and knowledge base") nor DELEGATION_CONTRACT above (which covers HOW
    // to delegate, not WHEN) ever told Olmo that a media-generation request
    // should route to a delegate at all. Live-tested via Studio: asked to
    // generate an ad, Olmo tried retrieve_documents, then list_folder, then
    // fell through to writing its own hallucinated markdown spec and
    // rendering that to canvas — agent-director was never called. Appended
    // last, same as the other contracts, so a thin persona override can't
    // drop it.
    const ROUTING_CONTRACT = `\n\n## Media generation routing — required behaviour
If the user asks to create, generate, make, draw, or produce an image, video, or ad, delegate to agent-director — do not try to answer from documents, search the knowledge base, or write a specification yourself. If the user asks to create or generate audio or music, delegate to agent-producer. If the message references a template by slug (e.g. "Template slug: product-demo"), pass that slug through to the delegate exactly as given — do not paraphrase it, search for it as a document, or drop it.`
    const COST_CONFIRMATION_CONTRACT = `\n\n## Credit-spending confirmation — required behaviour
Before calling agent-director, agent-producer, or any tool that generates an image, video, or audio (voiceover, music, sound effects, dubbing, voice cloning) — or a paid step around one, like background removal on a generated asset — you MUST first present a plan and wait for explicit approval. Never skip straight to generation, even if the user says "just generate it" or "go ahead" as their first message — the plan-and-estimate step still happens first; the only effect of that phrasing is that generation fires immediately once approval comes back.
The plan must state: what you intend to make (for video/audio, the full script or shot-by-shot breakdown, not a one-line summary), which delegate/model handles it, how many generations, duration per clip, aspect ratio, and resolution where applicable. Then give an estimated cost — say plainly it is an estimate, not a live rate lookup, and note if one approval covers the whole batch (e.g. multiple clips or images in one request).
Any plain affirmative ("yes", "go", "approved", "looks good", etc.) counts as approval — do not require the user to click a specific option. But approval is scoped to that exact plan: if the script, duration, style, or count changes afterward, treat it as a new plan and present a new estimate before spending again. Never regenerate to fix a bad result without a fresh confirmation, since a retry spends credits again too.
This does not apply to free operations — uploading files, browsing models, checking job status, transcripts, or analysis.
When the user's message is an affirmative reply to a media-generation plan you just proposed, your next action in that same turn MUST be a call to the appropriate delegate (agent-director for image/video, agent-producer for audio) — not a working-memory update, not a text reply. Do not write anything describing a completed or submitted generation before that delegate call has returned a result containing a fileId. If your response would describe generated or submitted media but no delegate call fired this turn, that is a failure: say plainly that generation could not be started and ask the user to retry, instead of narrating a result that did not happen.`
    const TEMPLATE_VIDEO_CONTRACT = `\n\n## Template video cloning — required behaviour
When the user wants to clone/recreate a reference ad's structure onto their own product (phrases like "clone this ad", "make a video like this template", "recreate this ad style for my product"):
1. Resolve the template: call retrieve_template with the slug if one is named in the brief. If retrieve_template returns { found: false }, tell the user and ask them to pick again — do not invent a structure.
2. Ask for a product photo if one hasn't been provided. Strongly recommend it over a text-only description — tell the user plainly that without a photo, product identity will not be preserved in the generated video, only what the words describe.
3. Delegate to agent-director to analyze the template (analyze_video/analyze_audio) and classify its profile before proposing a plan.
4. Before generation, the plan you present under COST_CONFIRMATION_CONTRACT above must ALSO include: the output aspect ratio (16:9 or 9:16 — ask if the template and product photo don't obviously agree), a one-line description of what will and will not carry over from the template (the template's own brand/packaging/on-screen text must never appear in the output), and — whenever the clone will include spoken dialogue — the EXACT words the generated actor will say, verbatim, for the user to approve. This dialogue approval is separate from the cost approval: if the user approves the cost plan but you haven't shown them the exact spoken line, ask for that separately before calling agent-director. If you later change the wording for any reason (including your own correction, e.g. respelling a brand name), you must show the user the new line and get it approved again before generating. Once the user has approved the spoken line, include it verbatim in your delegation to agent-director as the approved dialogue — Director needs this exact text to populate generate_video's approvedDialogue field, which is what lets the tool verify the generated prompt's quoted line matches what the user actually approved.
5. State known limits plainly when delivering the result: product identity will read as recognizably similar, not pixel-exact; a template with multiple distinct scenes is compressed into one clip today, not a multi-shot series.
(Post-generation transcript verification against the approved line is agent-director's responsibility, not yours — see Director's own instructions.)`
    const UGC_CHARACTER_CONTRACT = `\n\n## UGC character ad — intake and board review
When the user wants a UGC-style ad built from scratch (no template to clone), with MULTIPLE distinct beats/shots in a storyboard, PHOTOREAL not stylized — if the user instead wants a SINGLE continuous presenter speaking to camera for one continuous script, use the Talking-head ad contract below instead; if the user wants a STYLIZED/animated/cartoon-look story ad, use the Animation-character ad contract below instead — not this one:
1. Intake: get a product photo. Three-tier fallback if none exists: (a) ask for a real photo, (b) if none is available, delegate to agent-director to generate one first via generate_image and use that as the product photo, (c) only if the user wants to proceed with no photo at all, continue text-only and tell them plainly that product identity will not be preserved. Never silently pick (c) when a photo could be provided. Ask target vibe/audience, number of beats, and whether they want the same script repeated or distinct variants — ask this BEFORE giving any cost estimate.
2. Tell the user plainly, before delegating: generating N beats means N separate cost confirmations for stills and N more for video — there is no single approval that covers the whole board today.
3. Delegate to agent-director to generate the cast sheet. Once it succeeds, derive a terseTag (10-40 characters, wardrobe-anchored — for example, the woman in the yellow cardigan) and a styleLock (a SHORT clause, under 80 characters — for example, warm morning light, 35mm lens — not a full paragraph) from the brief and the cast sheet. Both strings are checked byte-for-byte against every later prompt in code, so keep them short and simple enough to copy-paste identically every time — do not vary punctuation, wording, or length once set. Write the cast sheet's fileId into working memory's Locked Reference Artifact IDs field and set Casting Choice to "generated character". Pass terseTag and styleLock to Director in every later delegation message for this ad, copied exactly, character for character — Director cannot see your working memory, you must restate them each time.
4. Delegate to agent-director to generate each beat's still, per its per-beat mode table.
5. Board review: once all stills exist, present them together and ask the user to approve the set as a whole for continuity — not each one individually. Only board-approved stills proceed to video. If the user rejects a still, regenerating it is a new paid call and needs its own fresh approval, same as any other retry.
6. Delegate to agent-director to render each approved still into a video clip.
7. Deliver each clip separately. Tell the user plainly that these clips are not assembled into one final ad, and that this character exists only in this conversation — it isn't saved to a reusable library.`
    const TALKING_HEAD_CONTRACT = `\n\n## Talking-head ad — intake, narration lock, and delivery
This contract applies when the user wants a SINGLE continuous PHOTOREAL presenter/spokesperson speaking to camera for one continuous script — not a multi-beat storyboard with distinct shots (that's the UGC character ad contract above), and not a stylized/animated look (that's the Animation-character ad contract below). Signals: "talking head", "presenter video", "spokesperson ad", "someone reading this script to camera".
1. Intake: get the full script text, a Cartesia voice pick (ask which language the narration should be read in if the brief implies anything other than English — pass that language through to Director), an optional product photo, and a presenter look brief (appearance, setting, wardrobe) if no photo anchors it.
2. Tell the user plainly, before delegating: this flow involves roughly 8-10 separate cost confirmations across the cast sheet, narration, per-clip stills, per-clip videos, assembly, and lip-sync — there is no single approval that covers the whole flow.
3. Delegate to agent-director to generate narration ONCE via generate_narration, using the full script and chosen voice (and language, if specified). When it succeeds, write BOTH the returned fileId and durationSeconds into working memory's Locked Reference Artifact IDs field, alongside the cast sheet's fileId. Restate this locked narration fileId and durationSeconds, copied exactly, in every later delegation to agent-director for this ad — assembly and lip-sync both need them, and Director cannot see your working memory, so you must include them again each time. Never re-delegate a fresh generate_narration call for the same ad unless the user has explicitly changed the script.
4. Delegate to agent-director to generate the cast sheet (same pattern as the UGC character contract's step 3) and write its fileId into working memory alongside the narration.
5. Delegate to agent-director to generate each clip's still, per its per-clip rules.
6. Board gate: once all per-clip stills exist, present them together and ask the user to approve the set as a whole for continuity — not each one individually. Only board-approved stills proceed to video. If the user rejects a still, regenerating it is a new paid call and needs its own fresh approval, same as any other retry.
7. Delegate to agent-director to render each approved still into a silent video clip, then to assemble them and lip-sync the result, restating the locked narration fileId/durationSeconds each time per step 3.
8. If the user changes the script after narration has already been generated, tell them plainly: a fresh narration call is required, and any stills already generated are sunk cost — this is a new plan requiring a new cost estimate, per the credit-spending confirmation rule above.
9. Delivery: present the final assembled, lip-synced video as ONE continuous ad with a deliberate visible cut where clips join — not as multiple separate clips. This is expected, not a defect to apologize for.`
    const ANIMATION_CHARACTER_CONTRACT = `\n\n## Animation-character ad — style pick, board gate, delivery
This contract applies when the user wants a stylized/animated/cartoon-look story ad built from scratch (no template to clone — if the user wants to clone an existing animated ad's structure, that's the template-cloning contract above, not this one) — a 3D-animated, flat-illustration, or claymation-style short film selling a product across a 4-beat arc, NOT a photoreal ad (that's the UGC character or Talking-head contracts above). Signals: "animated ad", "cartoon ad", "Pixar-style ad", "stylized character ad", "claymation ad". A stylized/animated SINGLE PRESENTER request (not a 4-beat story) is not supported by any current skill — tell the user plainly and offer either the photoreal Talking-head contract or this 4-beat animated story format as the closest available alternatives, rather than looping between contracts.
1. Intake: get a product photo (required — Doctrine C recreates it in-style, the real photo is only used for the end card and Gate 0's fit check). Ask which of exactly three styles the user wants: 3D animated (Pixar-like, warm and expressive), 2D flat/vector illustration (bold flat colors, simple shapes), or claymation (stop-motion clay look). If the user doesn't know, briefly describe all three and let them pick — never assume one.
2. Gate 0 fit check: before any cost estimate, tell the user plainly if the product doesn't fit this style — this format needs an emotional/relational pain point visible on a face, not a technical spec pitch. If it doesn't fit, say so and suggest a different skill (UGC character or talking-head) instead of building a charming ad for a product that needs a demo.
3. Tell the user plainly, before delegating: this flow involves roughly 20-23 separate cost confirmations across the cast sheet, 4 beat stills, 4 silent clips, narration/VO calls, lip-sync, muxing, end-card compositing, assembly, transcription, captions, and the music mix — there is no single approval that covers the whole flow.
4. Delegate to agent-director to generate the cast sheet (same pattern as the UGC character contract's step 3 — derive a terseTag and a matching STYLE block's styleLock from the chosen style). Write the cast sheet's fileId and the chosen style into working memory's Locked Reference Artifact IDs field.
5. Delegate to agent-director to generate each of the 4 beat stills, per its fixed beat-role rules (hook/low-point/turn/payoff).
6. Board gate: once the cast sheet and all 4 beat stills exist, present them together and ask the user to approve the set as a whole for continuity — not each one individually. Only board-approved stills proceed to video. If the user rejects a still, regenerating it is a new paid call and needs its own fresh approval.
7. Delegate to agent-director to render each approved still into a silent clip, generate the hook beat's narration and lip-sync it, generate beats 2-4's VO lines and mux each, composite the end card onto beat 4, assemble all 4 clips with audio preserved, transcribe the result, burn captions, generate the music bed, and mix it in last.
8. If transcribe_audio's brand-name check flags a mismatch, tell the user plainly and ask whether to retry the transcription/caption step or keep the brand name off narration and rely on the end card only.
9. Delivery: present the final captioned, scored video as ONE continuous 4-beat story ad. Tell the user plainly that this character exists only in this conversation — it isn't saved to a reusable library, same as the UGC character contract's own characters.`
    const THINKING_STYLE_CONTRACT = `\n\n## Reasoning style — required behaviour
Your reasoning is shown live to the user as "Thinking it through." Reason as a helpful assistant thinking out loud, in plain language a non-technical user would follow — never mention internal tool names, delegate/sub-agent names, function names, or system architecture (e.g. never say "agent-director", "retrieve_documents", "calling a sub-agent", "delegate", "tool call"). Describe what you're figuring out and doing in plain terms instead — e.g. "the user wants a short product ad, but hasn't said which product or platform" rather than "parsing user input for ask_clarifying_questions", and "generating the opening visual" rather than "delegating to agent-director". Open by briefly restating what the user is asking for in your own words and naming what's still unclear, when anything is.`
    const rawInvokedThisTurn = requestContext?.get('skillsInvokedThisTurn')
    const invokedThisTurn = Array.isArray(rawInvokedThisTurn) ? rawInvokedThisTurn : []
    return composed + CLARIFICATION_CONTRACT + CODE_BLOCK_CONTRACT + CANVAS_CONTRACT + IDENTITY_CONTRACT + SKILL_CREATION_CONTRACT
      + DELEGATION_CONTRACT + ROUTING_CONTRACT + COST_CONFIRMATION_CONTRACT + TEMPLATE_VIDEO_CONTRACT + UGC_CHARACTER_CONTRACT + TALKING_HEAD_CONTRACT + ANIMATION_CHARACTER_CONTRACT + THINKING_STYLE_CONTRACT + invokedSkillsInstruction(invokedThisTurn)
  },

  skills: async ({ requestContext }: { requestContext?: RequestContext<TenantContext> }) => {
    const tenantId = requestContext?.get('tenantId') as string | undefined
    const agentId = requestContext?.get('agentId') as string | undefined
    if (!tenantId || !agentId) return []

    // Set by chatStream.ts only for a Test-in-chat conversation (see
    // fetchConversationSkillSettings) — composes just that one skill,
    // never the agent's other real attached skills.
    const testSkillInstallId = requestContext?.get('testSkillInstallId') as string | undefined
    if (testSkillInstallId) {
      const skill = await fetchTestSkill(testSkillInstallId, tenantId)
      return skill ? [skill] : []
    }

    // The agent's attached skills, plus the skills turned on in this
    // conversation with "/". Both are native Mastra skills: listed by name
    // and description, loaded with the built-in `skill` tool.
    //
    // invokedSkillInstallIds is read here and ONLY here, from requestContext
    // — never from the conversation's stored metadata or any other
    // client-controlled source. Two checks apply, deliberately redundant,
    // neither removable as "already covered by the other": chatStream.ts
    // resolves the ids (stored and newly picked) against this tenant's
    // active, ready installs each turn before setting this key, and
    // fetchInvokedSkills below re-checks each one again at load time,
    // tenant-scoped, via resolveInstalledSkillContent — the real load-time
    // tenant and ready check. Falling back to a stored value here would
    // bypass chatStream.ts's check; dropping fetchInvokedSkills's own
    // resolution would bypass the load-time one.
    const invokedIds = (requestContext?.get('invokedSkillInstallIds') as string[] | undefined) ?? []
    const [attached, invoked] = await Promise.all([
      fetchAttachedSkills(agentId, tenantId),
      invokedIds.length > 0 ? fetchInvokedSkills(invokedIds, tenantId) : Promise.resolve([]),
    ])
    return mergeSkillSets(attached, invoked)
  },

  tools: async ({ requestContext }: { requestContext: RequestContext<TenantContext> }) => {
    const tenantId = requestContext.get('tenantId') as string | undefined

    if (!tenantId) {
      // No tenant context — return SERVER_TOOLS only (Studio / health checks)
      return SERVER_TOOLS
    }

    // --- Composio path (primary when COMPOSIO_ENABLED=true) ---
    if (isComposioEnabled()) {
      try {
        const composioTools = await getComposioTools(tenantId)

        // Filter out any Composio tools that conflict with SERVER_TOOLS.
        const filteredComposioTools = Object.fromEntries(
          Object.entries(composioTools).filter(([key]) => {
            const blocked = Array.from(SERVER_TOOL_NAMES).some(
              (name) => key === name || key.endsWith(`_${name}`)
            )
            if (blocked) console.log(`[mastra] platformAgent filtering Composio tool: ${key}`)
            return !blocked
          })
        )

        console.log(`[mastra] using Composio tools (${Object.keys(filteredComposioTools).length}) for tenant ${tenantId}`)
        return { ...filteredComposioTools, ...SERVER_TOOLS }
      } catch (err) {
        // Composio failed — fall through to MCP backup.
        console.warn('[mastra] Composio tool fetch failed, falling back to MCP:', (err as Error).message)
      }
    }

    // --- MCP path (backup / default when Composio is disabled or errored) ---
    const storedClient = requestContext.get('__mcpClient') as MCPClient | undefined
    const mcpClient = storedClient ?? getMCPClientForTenant(
      tenantId,
      requestContext.get('agentId') as string | undefined,
      requestContext.get('sessionId') as string | undefined,
    )

    const mcpTools = await getCachedMcpTools(mcpClient, tenantId)

    // Exclude MCP tools that duplicate SERVER_TOOLS.
    const filteredMcpTools = Object.fromEntries(
      Object.entries(mcpTools).filter(([key]) => {
        const blocked = Array.from(SERVER_TOOL_NAMES).some(
          (name) => key === name || key.endsWith(`_${name}`)
        )
        if (blocked) console.log(`[mastra] platformAgent filtering MCP tool: ${key}`)
        return !blocked
      })
    )

    return { ...filteredMcpTools, ...SERVER_TOOLS }
  },

  memory: getOlmoMemory(),

  // Sub-agent delegation to pm/architect/director/producer — gated to the
  // Olmo row only, since platformAgent is resolveAgent's fallback for every
  // unmatched agent name (Research Engineer, Analyst, custom agents, etc.).
  // See olmoDelegates.ts for the gate itself.
  //
  // Verified against @mastra/core 1.64 that a parent's own tool map is never
  // passed into a delegated sub-agent's tool list — the earlier concern here
  // (aiParas inheriting SERVER_TOOLS) does not reproduce; aiParas itself was
  // deleted from the codebase (57948a3d).
  //
  // Memory: the four delegates declare no `memory:` of their own, which stops
  // them deriving a resource id from a model-writable tool field. It does NOT
  // make delegated calls memory-inert — because THIS agent has
  // `memory: getOlmoMemory()` above, Mastra lends that instance to each
  // memory-less delegate and scopes it by that model-influenced id, so a
  // delegated turn still writes into the store under a steerable resource key.
  // The thing keeping that from being a cross-tenant READ is that
  // getOlmoMemory() pins thread-scoped recall and working memory — which is
  // exactly why Olmo has its own Memory instance instead of sharing
  // getMastraMemory() with director/pm/producer, who keep Mastra's default
  // resource scope for cross-conversation memory. Read getOlmoMemory()'s
  // note in memory.ts before changing memory config here or on any delegate.
  // Full mechanism: architectAgent.ts's delegate comment.
  agents: buildOlmoDelegates,

  // Retry transient stream failures IN THE SAME TURN so a mid-conversation
  // undici HeadersTimeoutError (or any error that surfaces isRetryable: true)
  // doesn't kill the turn with no assistant message persisted — which was
  // what caused mid-conversation state loss when the model on the next turn
  // saw a user message with no reply and re-asked the opening question set
  // (2026-09-14: fitness-app banner bug). Mastra's built-in matcher already
  // covers OpenAI Responses stream errors; the AI SDK's isRetryable flag
  // covers our undici timeouts through the inference-gateway proxy.
  errorProcessors: [new StreamErrorRetryProcessor({ maxRetries: 4, delayMs: 500 })],

  // Dynamic model selection — see modelSelection.ts for the precedence order and
  // why it's a separate module (testability: this file eagerly builds DB/network
  // singletons like getMastraMemory() at import time).
  model: selectModel,
})
