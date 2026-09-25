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
  [/\bdelegation\b/gi, 'handoff'],
  [/\bdelegates\b/gi, 'hands off'],
  [/\bdelegated\b/gi, 'handed off'],
  [/\bdelegating\b/gi, 'handing off'],
  [/\bdelegate\b/gi, 'hand off'],
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
  [/\bfind_past_tasks\b/gi, 'looking through your earlier tasks'],
  [/\bfind_in_folder\b/gi, 'searching the folder'],
  [/\bread_file\b/gi, 'reading the file'],
  [/\bpcTools_GMAIL_\w+\b/gi, 'using Gmail'],
  [/\btool[- ]?call(s|ed|ing)?\b/gi, 'step'],
  [/\bworking memory\b/gi, 'notes'],
  [/\brequestContext\b/gi, 'the current context'],
  [/\bupdate_?working_?memory\b/gi, 'updating notes'],
  [/\bcheck[-_]credit[-_]plan\b/gi, 'checking your credits'],
  [/\bgenerate[-_]images?\b/gi, 'creating the image'],
  [/\bgenerate[-_]videos?\b/gi, 'creating the video'],
  [/\bgenerate[-_]narration\b/gi, 'creating the voiceover'],
  [/\bgenerate[-_]song\b/gi, 'creating the music'],
  [/\bedit[-_]image\b/gi, 'editing the image'],
  [/\blipsync\b/gi, 'syncing the lips'],
  [/\bassemble[-_]clips\b/gi, 'assembling the clips'],
  [/\bmux[-_]beat[-_]audio\b/gi, 'adding the audio'],
  [/\btrim[-_]clip\b/gi, 'trimming the clip'],
  [/\bstretch[-_]clip\b/gi, 'adjusting the clip'],
  [/\boverlay[-_]text\b/gi, 'adding the text'],
  [/\btranscribe[-_]audio\b/gi, 'transcribing the audio'],
  [/\bcomposite[-_]end[-_]card\b/gi, 'adding the end card'],
  [/\bburn[-_]captions\b/gi, 'adding captions'],
  [/\bmix[-_]music[-_]bed\b/gi, 'mixing the music'],
]

// Tool names used as a noun ("the generate_image tool", "call generate_image")
// read badly with the verb-phrase replacements below ("the creating the image
// tool"). Handle the "<name> tool" form first with a noun phrase.
const TOOL_NOUNS: Array<[RegExp, string]> = [
  [/(\b(?:the|my own|its own|your own)\s+)?`?\bgenerate[-_]images?`?\s+tool\b/gi, 'the image generator'],
  [/(\b(?:the|my own|its own|your own)\s+)?`?\bgenerate[-_]videos?`?\s+tool\b/gi, 'the video generator'],
  [/(\b(?:the|my own|its own|your own)\s+)?`?\bgenerate[-_]song`?\s+tool\b/gi, 'the music generator'],
  [/(\b(?:the|my own|its own|your own)\s+)?`?\bgenerate[-_]narration`?\s+tool\b/gi, 'the voiceover generator'],
  [/(\b(?:the|my own|its own|your own)\s+)?`?\bedit[-_]image`?\s+tool\b/gi, 'the image editor'],
  [/\b(call|calling|use|using|invoke|invoking)\s+(my own\s+|its own\s+|the\s+)?`?generate[-_]image`?/gi, '$1 the image generator'],
]

export function redactReasoningText(text: string): string {
  let out = text
  for (const [pattern, replacement] of TOOL_NOUNS) out = out.replace(pattern, replacement)
  for (const [pattern, replacement] of REDACTIONS) {
    // Swallow markdown backticks around a name: `agent-director` would otherwise
    // render the friendly replacement in code font.
    const wrapped = new RegExp('`?' + pattern.source + '`?', pattern.flags)
    out = out.replace(wrapped, replacement)
  }
  // "the agent-director" -> "the the visual generation step" without this.
  return out.replace(/\b(the) the\b/gi, '$1')
}
