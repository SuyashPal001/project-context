// Incremental parser for the chat route's SSE stream (routes/chat.ts writes
// `event: X\ndata: JSON\n\n`, plus bare `: heartbeat` comments during long
// tool calls). Chunks arrive split anywhere, so state carries across push().
export class SseParser {
  private buf = ''
  push(chunk: string): Array<{ event: string; data: unknown }> {
    this.buf += chunk
    const out: Array<{ event: string; data: unknown }> = []
    let idx: number
    while ((idx = this.buf.indexOf('\n\n')) >= 0) {
      const block = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx + 2)
      let event = ''
      const dataLines: string[] = []
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue
        if (line.startsWith('event: ')) event = line.slice(7)
        else if (line.startsWith('data: ')) dataLines.push(line.slice(6))
      }
      if (!event) continue
      const raw = dataLines.join('\n')
      let data: unknown = raw
      try { data = JSON.parse(raw) } catch { /* keep string */ }
      out.push({ event, data })
    }
    return out
  }
}
