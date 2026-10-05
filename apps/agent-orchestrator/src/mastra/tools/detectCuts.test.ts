import { describe, it, expect } from 'vitest'
import { parseShowinfoCuts } from './detectCuts.js'

describe('parseShowinfoCuts', () => {
  it('reads every pts_time from ffmpeg showinfo output, rounded, skipping 0', () => {
    const stderr = '[Parsed_showinfo_1 @ 0x1] n:   0 pts:  1 pts_time:1.6 duration\n[Parsed_showinfo_1 @ 0x1] n:   1 pts:  2 pts_time:3.68 x\n[x] pts_time:0\n'
    expect(parseShowinfoCuts(stderr)).toEqual([1.6, 3.68])
  })
})
