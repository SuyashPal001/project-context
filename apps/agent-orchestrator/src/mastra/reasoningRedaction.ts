// Safety net for the "Thinking it through" UI: the model's own extended-thinking
// trace is streamed to the user close to verbatim (see chatStream.ts's
// reasoning-delta case). THINKING_STYLE_CONTRACT in platformAgent.ts asks the
// model not to name internal tools/delegates in its reasoning, but thinking
// output isn't fully prompt-steerable — this regex pass is the actual
// guarantee, applied to every chunk regardless of whether the model complied.
const REDACTIONS: Array<[RegExp, string]> = [
  [/\bagent-director\b/gi, 'the visual generation step'],
  [/\bagent-producer\b/gi, 'the audio generation step'],
  [/\bagent-pm\b/gi, 'the planning step'],
  [/\bagent-architect\b/gi, 'the technical design step'],
  [/\bagent-smoke\b/gi, 'an internal check'],
  [/\bdirectorAgent(Delegate)?\b/gi, 'the visual generation step'],
  [/\bproducerAgent(Delegate)?\b/gi, 'the audio generation step'],
  [/\bpmAgent(Delegate)?\b/gi, 'the planning step'],
  [/\barchitectAgent(Delegate)?\b/gi, 'the technical design step'],
  [/\bsub-?agents?\b/gi, 'specialists'],
  [/\bdelegat(e|es|ed|ing|ion)\b/gi, 'hand this off'],
  [/\bretrieve_documents\b/gi, 'searching your documents'],
  [/\bstart_task\b/gi, 'starting the task'],
  [/\bget_task_thread\b/gi, 'checking the task'],
  [/\binternet_search\b/gi, 'searching the web'],
  [/\bweb_fetch\b/gi, 'reading that page'],
  [/\bask_clarifying_questions\b/gi, 'asking a clarifying question'],
  [/\brequest_upload\b/gi, 'requesting a file upload'],
  [/\brender[-_]canvas\b/gi, 'preparing the canvas view'],
  [/\banalyze_audio\b/gi, 'analyzing the audio'],
  [/\banalyze_video\b/gi, 'analyzing the video'],
  [/\bdraft_skill\b/gi, 'drafting a skill'],
  [/\bsave_skill\b/gi, 'saving the skill'],
  [/\blist_folder\b/gi, 'listing the folder'],
  [/\bfind_in_folder\b/gi, 'searching the folder'],
  [/\bread_file\b/gi, 'reading the file'],
  [/\bpcTools_GMAIL_\w+\b/gi, 'using Gmail'],
  [/\btool[- ]?call(s|ed|ing)?\b/gi, 'step'],
  [/\bworking memory\b/gi, 'notes'],
  [/\brequestContext\b/gi, 'the current context'],
]

export function redactReasoningText(text: string): string {
  let out = text
  for (const [pattern, replacement] of REDACTIONS) {
    out = out.replace(pattern, replacement)
  }
  return out
}
