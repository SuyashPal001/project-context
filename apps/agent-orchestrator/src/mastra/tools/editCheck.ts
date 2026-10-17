// Did an edit add what nobody asked for? Image edits copy things from their reference images: a fan blade
// across the top, a dupatta over the face (fan runs real9-16, 2026-10-17). Compares the photo before and after
// the edit, given the change that was asked for. Shared by every skill that edits a photo. No answer is
// unknown, never a pass.
import type { AskFn, Img } from './tvcChecks.js'

export const ADDED_BY_EDIT_QUESTION = (change: string, belong: string[] = []): string =>
  `Image A is a photo before an edit; Image B is the same photo after it. The edit was asked to change only: ${change}. ${belong.length ? `These belong in the shot and do not count: ${belong.join(', ')}. ` : ''}Shoes, jewellery and anything worn with a new outfit are part of an outfit change. Is there anything in Image B that is not in Image A and is not part of that change: a new object, something in front of the camera (such as a blade, a cloth or a hand at the edge of the frame), something covering the face, or text? Changes in pose, how clothes fall and where existing things lie do not count. Reply ONLY JSON {"added":true|false,"what":"short, in plain words"}`

/** belong: objects the shot should have (the original's), which an edit may add or move (look 4's remote). */
export async function addedByEdit(ask: AskFn, before: Img, after: Img, change: string, belong: string[] = []): Promise<{ status: 'pass' | 'fail' | 'unknown'; reason: string }> {
  try {
    const v = await ask([{ text: 'Image A:' }, { image: before }, { text: 'Image B:' }, { image: after }, { text: ADDED_BY_EDIT_QUESTION(change, belong) }])
    if (v.added === true) return { status: 'fail', reason: `not in the photo it was edited from: ${String(v.what ?? 'something new').replace(/\.+$/, '')}` }
    if (v.added === false) return { status: 'pass', reason: 'nothing was added' }
  } catch { /* unknown */ }
  return { status: 'unknown', reason: 'the edit could not be compared with its photo' }
}
