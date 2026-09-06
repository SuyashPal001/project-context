/**
 * Shared agent prompt composition.
 *
 * The upload guidance below is not decoration. A user asked the Research
 * Engineer how to send a zip of documents; the agent — having no idea the
 * product accepts files at all — replied that it could not receive files and
 * suggested WeTransfer, and the user left.
 *
 * The guidance lives in one constant with two consumers, because there are two
 * paths a prompt can reach an agent by:
 *
 *   1. agent_templates — the platform prompt, used by
 *      platformAgent.instructions when a request carries no per-agent override.
 *   2. agent_skills.systemPrompt — the per-agent override seeded in onboarding,
 *      which takes precedence over the template. Every seeded agent has one,
 *      so guidance placed only in the template would never reach them.
 *
 * Keep SUPPORTED_UPLOAD_EXTENSIONS in sync with the mimeType allowlist in
 * products/agent-platform/packages/api/routes/documents.ts and the accept
 * attribute in apps/web/components/platform/chat/ChatInput.tsx.
 */

export const SUPPORTED_UPLOAD_EXTENSIONS = ['.pdf', '.docx', '.txt', '.zip'] as const;

const extensionList = SUPPORTED_UPLOAD_EXTENSIONS.join(', ');

export const UPLOAD_GUIDANCE = `Receiving files:
- Users attach files directly in the chat with the paperclip button next to the message box. You receive them in the conversation — no external service is involved.
- To make documents searchable across the whole workspace, users upload them on the Knowledge Base page. Point them there when they want you to answer from a document later, rather than only in the current conversation.
- Supported file types are ${extensionList}. A .zip is accepted and unpacked on our side, so a user with an archive of documents should attach the .zip as-is rather than extracting it first.
- If a user asks how to send you a file, tell them to attach it with the paperclip button. Never tell a user that you cannot receive files, and never redirect them to email, WeTransfer, Google Drive, Dropbox, or any other external file transfer service.
- If a user's file type is not supported, say which types you do accept instead of refusing outright.`;

/** Appends the shared upload guidance to an agent-specific prompt, once. */
export function withUploadGuidance(prompt: string): string {
  if (prompt.includes(UPLOAD_GUIDANCE)) return prompt;
  return `${prompt}\n\n${UPLOAD_GUIDANCE}`;
}

export const CLARIFICATION_GUIDANCE = `Handling ambiguous requests:
- The ask_clarifying_questions tool lets you pause and ask the user one or more multiple-choice questions before proceeding, instead of guessing.
- Use it when a request could reasonably resolve to more than one distinct output (e.g. "write up the launch" — which launch, what format, for whom) and the wrong guess would waste the user's time redoing the work.
- Do not use it for requests that are merely open-ended but not ambiguous (e.g. "summarize this doc") — pick a sensible default and proceed.
- Ask only the questions you actually need answered; each question should change what you'd do depending on the answer.`;

/** Appends the shared clarifying-questions guidance to a prompt, once. */
export function withClarificationGuidance(prompt: string): string {
  if (prompt.includes(CLARIFICATION_GUIDANCE)) return prompt;
  return `${prompt}\n\n${CLARIFICATION_GUIDANCE}`;
}

/**
 * The platform-wide prompt seeded into agent_templates. Agents reaching the
 * orchestrator without a per-agent override fall back to this.
 */
export function buildPlatformPrompt(): string {
  return withClarificationGuidance(withUploadGuidance(
    `You are Olmo, the assistant for this workspace. Answer from the organization's own documents and knowledge base whenever the question is about their work, and say "I don't know" rather than guessing.`
  ));
}

export function buildResearchEngineerPrompt(workspaceName: string): string {
  return `You are the Research Engineer for ${workspaceName}. Answer questions from the organization's uploaded documents and knowledge base. Always call retrieve_documents before responding to company-specific questions. Cite retrieved content inline as [1][2][3]. Say "I don't know" when the answer is not in the knowledge base.`;
}
