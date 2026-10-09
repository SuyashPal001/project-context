# TVC Part 2.3: 30-Second Ads with a Two-Stage Join (Design)

Status: draft for review. Branch `tvc-30s` from origin/main 723ddab0.

## 1. Goal

The TVC skill can make a 30 s ad, the most common Indian TV length. A 30 s ad at real TVC pace (1.2–2.5 s cuts) needs about 14–20 shots. `assemble_clips` joins at most 12 clips by design (it verifies its own length and softens each cut), so the join runs in two stages: each half is joined and checked, then the two halves are joined and checked. The plan decides where the halves split, in code, so a split never breaks a continuing shot, and every stage keeps the frame rate and passes the length check.

## 2. What exists today

| Piece | Today | Change |
|---|---|---|
| `brief.lengthSeconds` | 6, 15 or 20 (refined number) | Adds 30 |
| Word cap (voiceover and lines) | 6s 8, 15s 22, 20s 30 | 30s 45 (from the Part 1 spec) |
| `MAX_SHOTS` | 12 | 12 for 6/15/20 s; **20 for 30 s** |
| `assemble_clips` | max 12 clips, length check (0.1 s + 0.03 s per clip), 40 ms fades, keeps fps | Unchanged; called once per half and once for the halves |
| Finish slice | one `assemble_clips` call over every shot | For a plan with more than 12 shots, returns `joinGroups` (two ordered lists of shot numbers) and the final join |
| Credit estimate | one join step | One join step per group, plus the final join |
| Reference recreation | cut times from the reference, ≤ 12 shots | A 30 s reference with up to 20 cuts can be matched |

## 3. Design

### J1: plan rules for 30 s
- `lengthSeconds` accepts 30. The refine message lists 6, 15, 20 and 30. It stays a refined number, never a numeric enum.
- `WORD_CAPS[30] = 45`.
- The shot limit comes from `maxShotsFor(length)`: 20 for 30 s, otherwise 12. Error: `there are N shots; a <len>s ad takes at most M`.
- The packshot is still 2–4 s, and the brand must still appear by 3 s. The other rules (shot lengths, angle, continuing shots, legal, jingle, price, logo) are unchanged and apply to 30 s as they are.
- The length lock (reference recreation) is unchanged. A 30 s reference is planned at 30 s.

### J2: where the halves split (`joinGroups`), computed in code
- This applies only when there are more than 12 shots. With 12 or fewer, the finish slice stays byte-identical to today.
- The split point is a shot boundary that:
  - (a) is not inside a continuing pair, so it never splits a shot from the shot that continues it;
  - (b) leaves each half with at most 12 shots;
  - (c) among valid boundaries, is nearest the middle by time;
  - (d) prefers a boundary where the location changes, among the valid boundaries within ±2 shots of the middle.
- No valid split means a plan error, `JOIN_SPLIT_IMPOSSIBLE: …`. This should never happen with 20 shots, and a test pins it.
- The finish slice returns:
  - `joinGroups: [[1..k], [k+1..n]]`;
  - `finalJoin: true`;
  - `finishOrder` with the joins in front (join half 1, join half 2, join halves, then the existing steps).

### J3: the two-stage join, using the existing tool
- Each half is joined by `assemble_clips` with `preserveAudio`, `roomTone` and the same flags as today, so each stage gets its own length check and keeps the frame rate.
- The halves are joined by `assemble_clips` with the two half videos and `preserveAudio`, with no transitions. This seam gets the same 40 ms audio fades as any other cut.
- The length check at every stage catches drift early: each stage checks `assemble_clips`' own length against its inputs, not against the overall planned length. The real run gave 30.21s for 30.0s of clips, which is outside the 2-clip tolerance against the planned length — within tolerance only when measured stage by stage, against each stage's own inputs.
- Room tone is not added twice: the final join passes `roomTone: false`, because each half already carries it. A test pins this.
- `assemble_clips`'s 12-clip cap is unchanged. A 13-clip call is still refused.

### J4: credits and approval
- `tvcCreditSteps` counts one join per group plus the final join when there are more than 12 shots, and stays unchanged otherwise.
- The cost card shows the real total for a 30 s ad: more stills, more clips and a longer voiceover.

### J5: Director and Olmo text (append only)
- **director.md:** when the finish slice has `joinGroups`, join each group with `assemble_clips` in order, then join the two results; follow `finishOrder`.
- **tvc-ad.md:** 30 s is offered as a length. Olmo says plainly that a 30 s ad costs about twice a 15 s one (more shots) before planning.

## 4. Edge cases

| # | Case | Decision |
|---|---|---|
| E1 | 13 shots, where every middle boundary is inside a continuing pair | Pick the nearest valid boundary. If none keeps both halves at 12 or fewer, return `JOIN_SPLIT_IMPOSSIBLE` (a test proves it can't happen at 20). |
| E2 | A disclaimer, price or jingle spanning the seam | No effect. Text, voiceover, jingle and music are added after the final join, on the whole ad. |
| E3 | Different fps between halves | Each half keeps its source fps (from Part A), and the final join keeps it too. Mixed sources fall back as today. |
| E4 | The final join drifts | `DURATION_MISMATCH` at that stage, with a refund. Director reports it, and a re-run of only the final join is cheap. |
| E5 | Re-check of a 15 s plan changed to 30 s | The length lock refuses it when a reference is planned. Otherwise it is a new plan (clips re-made, as today). |
| E6 | 6, 15 or 20 s plans | Unchanged: no `joinGroups`, same slices, same price (pinned). |
| E7 | A 30 s reference with more than 20 cuts | Refused with a plain message from the cut-time rule (a plan can't match it). Suggest a cutdown or a 30 s plan at our pace. |
| E8 | The talking-head, UGC and animated skills | Not affected. They don't use `plan_tvc` or `joinGroups`, and `assemble_clips` is unchanged. |

## 5. Testing
- **Unit:**
  - 30 s accepted and other lengths refused, with no numeric enum;
  - the word cap at 45;
  - the shot cap per length;
  - the split point: middle, continuing pair, location preference and impossible case;
  - the finish slice with 13 and 20 shots;
  - the legacy pins at 12 shots or fewer;
  - credit steps.
- **Real ffmpeg (tagged; runs locally, no libass needed):** build 20 tiny 24 fps clips (about 1.5 s each), join them in two halves and then the halves, and assert the output is 24 fps, its length is the sum ± tolerance, and audio fades are present at the seam.

## 6. Not in this piece
- Cutdowns from a 30 s ad to 15 s and 6 s (the next piece).
- Lengths other than 6, 15, 20 and 30.
- Raising `assemble_clips`'s 12-clip cap.
