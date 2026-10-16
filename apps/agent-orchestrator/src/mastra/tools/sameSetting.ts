// "Are these two images the same place?" — one shared check for any skill that keeps a setting across
// shots (the fan reel's look 1 came out on a different rug from looks 2-4, 2026-10-16). Judges the place
// only. A missing or odd answer is unknown (null), never a pass.
import type { AskFn, Img } from './tvcChecks.js'

export const SAME_SETTING_QUESTION = 'Do image 1 and image 2 show the same place? Judge ONLY the setting: the floor or rug (its pattern and colour), the furniture, walls, windows and the direction of the light. Ignore the people, their clothes and poses, and small changes of framing. Reply JSON {"same": true or false, "differs": "what is different, a few words; empty when the same"}'

export async function sameSetting(ask: AskFn, a: Img, b: Img): Promise<{ same: boolean | null; differs: string }> {
  try {
    const r = await ask([{ text: SAME_SETTING_QUESTION }, { text: 'image 1:' }, { image: a }, { text: 'image 2:' }, { image: b }])
    return { same: typeof r.same === 'boolean' ? r.same : null, differs: typeof r.differs === 'string' ? r.differs : '' }
  } catch (err) {
    console.error('[sameSetting] no answer:', err instanceof Error ? err.message : String(err))
    return { same: null, differs: '' }
  }
}
