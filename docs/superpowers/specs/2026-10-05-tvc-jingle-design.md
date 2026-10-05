# TVC Ad Part B: the Sung Jingle (Design)

Status: draft for review. It expands the Part B outline in `2026-10-05-tvc-quality-tools-design.md` §4, which was approved as an outline.
Branch: `tvc-ad-spec`, built on top of Part 1 and Part A, and merged once with them.

## 1. Goal

A TVC ad can end on a short sung sign-off: the brand line, sung, as a sonic logo over the packshot. This is what the Coke, 7UP and chai references do.
- The jingle is made by Lyria 3 (sung, any language including Hindi).
- The tools cut and level it, so a good result does not depend on prompt text.

What we already know (tested 2026-10-05, files in `~/Desktop/jingle-test/`):
- `lyria-3-clip-preview` sings the given lyrics exactly.
- It returns a 30.77s MP3 plus timestamped lyrics, e.g. `[9.4:14.9] Chai Nation, mazaa baar baar`.
- It costs $0.04 per clip.
- Jingle 1 was approved by ear.
- When not level-matched, the sung line came out about 8 LU louder than the speech.

## 2. What exists today

| Piece | Today | Part B change |
|---|---|---|
| Gateway `music.ts` | `lyria-002` only (`:predict`, regional, instrumental WAV) | Adds `lyria-3-clip-preview`: a separate code path (`generateContent`, location **global**, `responseModalities: ["AUDIO","TEXT"]`) that returns MP3 + lyrics text |
| `generate_song` | Instrumental music bed on lyria-002 | Unchanged |
| `mix_voiceover` | Voice blocks at planned starts, ducks the base under them | Blocks gain `kind: 'voice' \| 'jingle'`; jingle blocks are level-matched |
| `mix_music_bed` | Music bed under the whole ad | Gains optional `fadeOutAtSeconds`, so the bed clears before the sign-off |
| TVC plan | `songFileId` for the bed | Adds `brief.jingle` and the recorded jingle files; adds timing rules |

## 3. Design

**Reuse first.** Mastra's own pieces are already what the tools use: `createTool`, and `requireApproval` for the approval card. Mastra Voice is speech in and out for agents, not music, so it does not apply. Most of the machinery already exists in the repo and is reused, not rebuilt:
- **Gateway `music.ts`:** route, auth, breaker and the transient-500 retry. J1 adds a branch to it, not a new route.
- **`generate_song`:** charge-first, approval, refund and upload. J3 extends this tool instead of adding a new one.
- **`tightenPauses.parseSilences`:** the silencedetect parsing for J4.
- **`mixVoiceover.loudnessProbeArgs`:** ebur128 loudness measurement for J6.
- **`resolveRate(subject)`:** per-model credit rates, so only a seed row is new.

The new code is small:
- the Lyria 3 request and parse
- the timed-lyrics parser and the cut
- the level match
- the plan fields
- the skill lines

### J1 — Gateway route
- `MUSIC_MODEL_ALLOWLIST` gains `lyria-3-clip-preview`.
- Requests for it go to `https://aiplatform.googleapis.com/v1/projects/{p}/locations/global/publishers/google/models/lyria-3-clip-preview:generateContent` with:
  - body `{ contents: [{ role: 'user', parts: [{ text: '<style>\n\nLyrics:\n[Chorus]\n<lines>' }] }], generationConfig: { responseModalities: ['AUDIO','TEXT'] } }`.
- Request: `{ model, prompt, lyrics?: string[] }`.
- Response: `{ audioBase64, mimeType: 'audio/mpeg', lyricsText }`, where `lyricsText` is the text parts joined.
- A content block maps to `{ refused: true, reason: 'CONTENT_BLOCKED' }`, using Part A's `isContentBlocked`.
- It uses the same breaker and the same one retry on Lyria's transient 500 as lyria-002, and has no fallback tier.
- lyria-002 requests are byte-identical to today's.
- Test: the request URL, body and modalities; the parse of audio and text parts; a content block becomes CONTENT_BLOCKED.

### J2 — `parseTimedLyrics` (pure, orchestrator)
- It reads lines like `[9.4:14.9] text` and returns `{ start, end, text }[]`.
- Lines without a timestamp are ignored.
- `findLine(lines, wanted)` finds the line that best matches the sign-off text after normalising (lowercase, no punctuation; word overlap ≥ 0.8).
- Test: real Lyria text from the 2026-10-05 runs, a Hindi line, a missing line.

### J3 — sung mode on `generate_song` (paid; no new tool)
`generate_song` gains an optional `line`. When `line` is set, the call becomes a sung jingle on `lyria-3-clip-preview`. Without it, the call is byte-identical to today's lyria-002 instrumental. The rest of this section calls the sung mode "generate_jingle" for short.
- **Inputs:**
  - `line`: the sung sign-off, e.g. "Bubbli, feel the magic"
  - `lyrics?`: extra lines sung before it
  - `style`: genre and mood, e.g. "bright pop, female vocal, 120 bpm"
  - `language?`
  - `title?`
- **Flow:**
  - Charge first: rate `music_generation` / `lyria-3-clip-preview`, $0.04, through a new credit-rate seed row.
  - Approval: generate_song's own `shouldRequireApproval` path, keyed on the model that will run. Charge keys go through `stableToolCallId()`.
  - Gateway call (J1).
  - Find the sign-off line in the timestamps (J2). If it is not found, the result is `JINGLE_LINE_NOT_SUNG: Lyria did not sing "<line>"; try once more or shorten the line`, and the charge is refunded.
  - Cut the sign-off (J4). Upload both the full clip and the cut.
- **Output:**
  - `fileId` (full 30s clip) and `signoffFileId`
  - `signoffSeconds`
  - `lines` (the timed lyrics)
- Refunds on every failure path: gateway error, content block, line not sung, cut failure, upload failure.

### J4 — the sign-off cut (pure ffmpeg)
- The cut starts at the sung line's start minus 0.15s, so the first consonant is kept.
- It ends at the first silence after the line's end, found with `silencedetect=noise=-35dB:d=0.25`. It is capped at the line end + 2.0s, so a held note can ring out but the next verse is never included.
- A 0.9s fade-out on the cut, plus 20ms in.
- Mono stays stereo; the output is 48kHz AAC, to match the video mix.
- Test (real ffmpeg, tagged): a synthetic tone with a gap gives a cut that ends at the gap, with the fade present.

### J5 — plan fields and rules (`tvcPlan.ts`)
- `brief.jingle?: { line: string; style: string; lyrics?: string[]; language?: string }`.
- `plan_tvc record` gains `jingleFileId`, `signoffFileId` and `signoffSeconds`.
- **Rules:**
  - The sign-off ends with the ad: its start is `length − signoffSeconds`, computed by the plan rather than chosen by Director.
  - It starts at least 0.75s after the last speech, whether voiceover or an on-camera line. Otherwise record refuses with `JINGLE_OVERLAPS_SPEECH: the sung line would start <x>s after the last word; shorten the line or end the voiceover earlier`.
  - A sign-off longer than the packshot plus 2s is refused (`JINGLE_TOO_LONG`).
- The finish slice returns `signoffStartSeconds` and `musicFadeOutAtSeconds`, set to sign-off start − 0.3s.
- `tvcCreditSteps` adds one `music` step when `brief.jingle` is set.
- Plans without `brief.jingle` validate and slice exactly as before.

### J6 — mixing
- **`mix_voiceover`:** a block gains `kind?: 'voice' | 'jingle'`, default `voice`.
  - A jingle block is not ducked against and does not duck the base.
  - Instead it is level-matched. The tool measures the integrated loudness (ebur128) of the mixed audio in the 5s before the block.
    - If speech is in that window, the jingle's target equals the speech loudness.
    - Otherwise the target is the base + 2 LU.
  - The jingle's gain is set to reach that target, clamped to ±12 dB.
  - Test: a filter-graph unit test; a real-ffmpeg test where a jingle 8 LU too loud comes out within ±1 LU of the target.
- **`mix_music_bed`:** optional `fadeOutAtSeconds`, which applies a 0.5s fade on the bed ending there. When unset, the result is unchanged.

### J7 — skill text (additive)
New lines in `tvc-ad/director.md`, appended, never reworded:
- When the brief has a jingle, make it with generate_song with `line` set in the music step, and record the three values.
- Pass the sign-off as a `kind: 'jingle'` block at the slice's `signoffStartSeconds`.
- Pass `fadeOutAtSeconds` to mix_music_bed.
- On `JINGLE_LINE_NOT_SUNG`, try once more (it was refunded), then ask the user.

New lines in `tvc-ad.md`:
- Olmo asks about a sung sign-off only when the user wants one or the reference has one. The default is no jingle.

## 4. Error handling
- New plain reasons:
  - `JINGLE_LINE_NOT_SUNG`
  - `JINGLE_OVERLAPS_SPEECH`
  - `JINGLE_TOO_LONG`
  - `CONTENT_BLOCKED` (from Part A)
- Paid steps charge first and refund on every failure path.
- No automatic paid redo except the one documented retry after a refunded refusal.

## 5. Testing
- **Unit:** every row above.
- **Real, tagged (`RUN_JINGLE_REAL=1`):**
  - one Lyria 3 call on project `excellent-setup-486815-c1`, never fitnearn-devops
  - assert the line is found, the cut is between 1.5s and 8s, and the cut ends in silence
  - cost $0.04
- **Real ffmpeg (tagged):** J4 cut and J6 level match.
- **Live:** the Bubbli ad with a "Bubbli, feel the magic" sign-off, compared by ear with v5's ending.

## 6. Deploy
- Credit-rate seed: the `lyria-3-clip-preview` row.
- Official-skills seed.
- Restart the orchestrator and the inference gateway.
- The VM's gateway project must have Lyria 3 at location global. Check with one call before the live test.

## 7. Not in this piece
- Lyria 3.5: it is Gemini-API only.
- Picking a jingle from several takes (one take per call; the user can ask again).
- Voice cloning for the singer.
- A jingle outside the TVC flow. Any skill can already call generate_song with `line` later.
