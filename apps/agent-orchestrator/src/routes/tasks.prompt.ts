import type { TaskStep, TaskComment, CompletedStep } from '../types.js'

export function buildStepPrompt(
  step: TaskStep,
  taskTitle: string,
  taskDescription: string,
  completedSteps: CompletedStep[],
  comments: TaskComment[],
  referenceText?: string | null,
  links?: string[] | null,
  attachmentContext?: string | null
): string {
  const params = JSON.stringify(step.parameters, null, 2)
  const lines = [
    `<session_context>`,
    `task_step: ${step.title}`,
    `</session_context>`,
    ``,
    `You are executing a task step as part of an automated workflow.`,
    ``,
    `**Task Title:** ${taskTitle}`,
    `**Task Description:** ${taskDescription}`,
  ]

  if (referenceText) {
    lines.push(``, `## Reference Material`, `The user provided this reference text for context:`, referenceText)
  }

  if (attachmentContext) {
    lines.push(``, `## Attached Files`, `The user has attached the following files. Use this content to complete this step:`, attachmentContext)
  }

  if (links && links.length > 0) {
    lines.push(``, `## Relevant Links`, `The user attached these links. Use them as context or fetch their content if needed:`, ...links.map(l => `- ${l}`))
  }

  if (completedSteps.length > 0) {
    lines.push(``, `**Previously Completed Steps:**`)
    for (const cs of completedSteps) {
      lines.push(`- ✅ ${cs.title}: ${cs.summary}`)
      if (cs.results.length > 0) {
        lines.push(`  Results:`)
        for (const r of cs.results) {
          lines.push(`  - ${r.title}: ${r.url} — ${r.description}`)
        }
      }
    }
  }

  if (comments.length > 0) {
    lines.push(``, `**Comment History:**`)
    for (const comment of comments) {
      const author = comment.authorName ?? (comment.agentId ? 'Agent' : 'User')
      const timestamp = comment.createdAt ? ` (${comment.createdAt})` : ''
      lines.push(`- ${author}${timestamp}: ${comment.content}`)
    }
  }

  lines.push(
    ``,
    `**Current Step:** ${step.title}`,
    `**Description:** ${step.description}`,
    `**Tool:** ${step.toolName}`,
    `**Parameters:**`,
    '```json',
    params,
    '```',
    ``,
    `Execute this step using the ${step.toolName} tool with the provided parameters.`,
    ``,
    `After the tool has run and you have the results, write your final response as a single JSON object in this exact format:`,
    `{`,
    `  "reasoning": "<why this step was needed and what you did>",`,
    `  "toolRationale": "<why you chose this specific tool>",`,
    `  "results": [`,
    `    { "title": "<result title>", "url": "<complete URL starting with https://>", "description": "<what this is and why relevant>" }`,
    `  ],`,
    `  "summary": "<1-2 sentence human readable summary of what you found or did>"`,
    `}`,
    ``,
    `Important:`,
    `- Call the tool first. Write the JSON only after you have the tool results.`,
    `- Every URL must be complete (e.g. https://github.com/owner/repo)`,
    `- If the step produces no URLs, set results to []`,
    `- If you cannot proceed without user input, set summary to: NEEDS_CLARIFICATION: <your question>`,
  )
  return lines.join('\n')
}

export function extractClarificationQuestion(text: string): string | null {
  // [^\n"]+ stops at newline or closing quote — prevents consuming trailing JSON syntax
  // when summary falls back to raw agentOutput that still contains JSON characters
  const match = text.match(/NEEDS_CLARIFICATION:\s*([^\n"]+)/m)
  return match ? match[1].trim() : null
}
