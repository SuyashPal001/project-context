// A mid-turn answer becomes the user's next message (see pauseTurn/resumeTurn
// in chatStream.ts), so it is written the way the user would have typed it:
// the options they picked and anything they wrote, not "question 0: index 2".

type Question = { prompt: string; options: Array<{ label: string }> }
type Answer = { questionIndex: number; selectedIndex?: number; selectedIndices?: number[]; freeText?: string; skipped?: boolean; files?: unknown[] }

export type TurnPauseFn = () => void
export type TurnResumeFn = (answer: string, files?: Array<{ fileId: string; name: string; type: string }>) => void

/** "Looks good — continue (Recommended)" -> "Looks good — continue": the hint was for choosing, not for the reply. */
const plain = (label: string) => label.replace(/\s*\(Recommended\)\s*$/i, '').trim()

export function clarificationAnswerText(questions: Question[], answers: Answer[]): string {
  const lines = answers
    .slice()
    .sort((a, b) => a.questionIndex - b.questionIndex)
    .map((a) => {
      const q = questions[a.questionIndex]
      const picked = a.selectedIndices?.length
        ? a.selectedIndices.map((i) => q?.options[i]?.label).filter((l): l is string => !!l).map(plain)
        : a.selectedIndex !== undefined && q?.options[a.selectedIndex]
          ? [plain(q.options[a.selectedIndex].label)]
          : []
      const note = a.freeText?.trim()
      const files = a.files?.length ? `${a.files.length} file${a.files.length === 1 ? '' : 's'} attached` : ''
      const parts = [picked.join(', '), note, files].filter(Boolean)
      if (parts.length === 0) return a.skipped ? 'Skipped' : ''
      return parts.join(' — ')
    })
    .filter(Boolean)
  return lines.join('\n') || 'Skipped'
}

export function uploadAnswerText(answer: { files: unknown[]; freeText?: string; skipped?: boolean }): string {
  const note = answer.freeText?.trim()
  if (answer.files.length > 0) return note || `Uploaded ${answer.files.length} file${answer.files.length === 1 ? '' : 's'}`
  return note || 'Skipped'
}

/**
 * The line a part hands its work over with, when Olmo wrote nothing before
 * asking: "Here's Scene 1 Still — Ishita." Like an employee handing work to
 * the boss — one line, then the one question (2026-10-07).
 */
export function handoverLine(files: Array<{ name: string; type: string; working?: boolean }>): string {
  // Audio too: the first narration line is handed over to be heard (2026-10-07).
  const made = files.filter((f) => !f.working && /^(image|video|audio)\//.test(f.type))
  if (made.length === 0) return ''
  const names = made.map((f) => {
    const name = f.name.replace(/\.[a-z0-9]{2,4}$/i, '').trim()
    return /^generated narration$/i.test(name) ? 'the narration' : name
  })
  if (names.length === 1) return `Here's ${names[0]}.`
  if (names.length <= 3) return `Here are ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}.`
  const kindOf = (f: { type: string }) => f.type.split('/')[0]
  const noun = made.every((f) => kindOf(f) === 'video') ? 'clips' : made.every((f) => kindOf(f) === 'image') ? 'pictures' : made.every((f) => kindOf(f) === 'audio') ? 'recordings' : 'files'
  return `Here are the ${made.length} ${noun}.`
}
