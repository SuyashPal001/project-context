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
