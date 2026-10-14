import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, renameSync, unlinkSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const execFile = promisify(execFileCb)

// ffmpeg writes to a temp name and is renamed only on success, so a killed or
// timed-out run never leaves a partial file that later calls reuse as cached
// (review I5). Concurrent callers each get their own temp file.
export async function ffmpegToFile(args: string[], out: string, opts: { timeout: number; signal?: AbortSignal }): Promise<string> {
  if (existsSync(out)) return out
  const tmp = `${out}.tmp-${process.pid}-${randomBytes(4).toString('hex')}.mp4`
  try {
    await execFile('ffmpeg', [...args, tmp], opts)
    renameSync(tmp, out)
    return out
  } catch (err) {
    try { unlinkSync(tmp) } catch { /* nothing written */ }
    throw err
  }
}
