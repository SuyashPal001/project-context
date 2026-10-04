# TVC ad — Official skill design (Part 1)

Date: 2026-10-05
Status: design approved in conversation; awaiting written-spec review
Research notes: memory `project_tvc_ad_research.md` (six reference TVCs broken down, two Gemini Deep Research reports, OpenFrame AI read-through)

## 1. Goal

A new Official skill, **TVC ad**, that turns one brief into a polished TV-commercial-style ad (several fast-cut shots, voiceover, on-screen text, and a packshot from the real product photo). It is a separate skill like Talking head and UGC character ad, and it is discoverable the same way: it has a Skills-page showcase card, a pointer line in Olmo, and its own `director.md` loaded on a marker.

It is one skill, not one per format. A single "system" (five levels plus picking rules) composes the right ad from the brief. v1 covers two ad kinds seen in the user's references:

- **Mood shift, no dialogue** (Coca-Cola "Real Magic", 7UP): a product moment, a visual payoff, music and sound effects, an optional "superpower" shot with no actor.
- **Ambassador spot** (Lakmé 9to5, Yakult): a TVC actor, at most two on-camera lines, an announcer voiceover, short feature text, a packshot.

Out of scope for v1: multi-character dialogue comedy (Suhana), the narrated-anecdote format (Heinz), sung jingles, and broadcast masters.

**Success:** a 15-second ad for a real product that cuts like the references. The brand is visible within 2 seconds, the actor's face is the same in every shot, the product label is correct, the voiceover ends before the packshot, and the ad is built from one brief with only the planned approvals.

## 2. Decisions already made

| Decision | Choice |
|---|---|
| Skill shape | One Official skill `tvc-ad`; the TVC character creator stays a separate skill and supplies the actor |
| Pace | Real TVC pace: generate shots at 3s or more, trim each to 1.2–2.5s (packshot 2–4s). Costs roughly 2x the ad's length in generated video |
| Default length | 15s (6, 15, 20 and 30 allowed) |
| Aspect ratio | Asked every time (16:9 or 9:16); no default |
| Market | Global core plus a market pack. India and Generic ship first; other countries are added when real users from them arrive. Legal items are applied as a checklist; the product never claims an ad is "compliant" |
| Plan enforcement | Typed plan plus a `plan_tvc` tool that checks the craft rules in code (approach B). Rejected: prompt-only rules (Flash skips rules in long skills), and a single `build_tvc` tool (long blocking calls, loses per-step approval) |
| Step-wise | Every step is one Director delegation that does one thing, saves it and stops. This bounds both generation credits and LLM tokens |
| Concept check | The user's plan approval is the concept check. No separate critic LLM call |
| On-camera speech | Native Omni speech via `approvedDialogue` (verified better than TTS plus lip-sync in Talking head) |
| Voiceover voice | Announcer voice by default, so no actor/narrator voice mismatch. The actor's own voiceover needs voice cloning (Part 2) |

## 3. The flow

| Step | Director does | Paid | User sees and decides |
|---|---|---|---|
| 1. Plan | Fills the plan; `plan_tvc check` validates and saves it, returning a cost estimate | LLM only | Script, shots in plain words, look, cost. Approve or change |
| 2. Stills | One start frame per shot, from the actor's reference sheet and the product photo | Images | All stills together. Approve, or redo one |
| 3. Clips | A few shots per delegation: generate, check, retry once, trim, record | Video | Each finished group. Continue, or redo a shot |
| 4. Finish | Packshot, join, voiceover, voiceover mix, text, music | Small | One finished ad. Redo any single shot |

Step 3 of the agreed flow, the animatic preview, is Part 2. The numbering above is Part 1's.

Token controls:

1. The plan lives in a file. Each delegation names the plan's fileId and the step (for example `step: clips 4-6`). Director reads only that slice through `plan_tvc get`. Olmo never restates the plan.
2. The skill card stays short: when to use it, the four steps, what to ask. Craft rules live in `plan_tvc` and the tools.
3. `director.md` loads only on the `flow: tvc ad` marker and holds only what code cannot decide (prompt craft for the look, shot types and product).
4. Tools return a fileId and a one-line status, never the plan.

Spend controls: nothing is paid before the plan is approved; stills come before video; clips go in small groups; a failed check retries once and then stops and asks; single-shot redo reuses everything else.

## 4. The plan

One JSON document, saved as a file by `plan_tvc check`.

```ts
type TvcPlan = {
  brief: {
    message: string                    // the single-minded proposition, one sentence
    category: 'beauty' | 'personal_care' | 'food' | 'beverage' | 'jewellery' | 'fashion' | 'home' | 'tech' | 'other'
    tier: 'mass' | 'premium' | 'luxury'
    objective: 'launch' | 'brand' | 'feature' | 'seasonal'
    market: 'india' | 'generic'
    lengthSeconds: 6 | 15 | 20 | 30
    aspectRatio: '16:9' | '9:16'
    productPhotoFileId: string
    actorAvatarId?: string             // omitted for a no-actor mood-shift ad
  }
  look: string                         // one line, appended to every image and video prompt
  locations: string[]                  // at most 2
  shots: Array<{
    n: number
    type: 'hook' | 'reaction' | 'hero' | 'lifestyle' | 'reach' | 'product_macro' | 'mechanism' | 'superpower' | 'packshot'
    size: 'wide' | 'medium' | 'close_up' | 'extreme_close_up'
    action: string                     // one line
    location?: number                  // index into locations
    durationSeconds: number
    brandVisible: boolean              // product, logo or branded set on screen
    productVisible: boolean
    audio: 'silent' | 'line' | 'voiceover'
    line?: string                      // only when audio is 'line'
    text?: string                      // on-screen text for this shot
    stillFileId?: string               // written by record
    clipFileId?: string                // written by record (the trimmed clip)
  }>
  voiceover: Array<{ text: string; startSeconds: number }>
  packshot: { kind: 'product' | 'product_range' | 'actor_product_tagline' | 'logo_over_scene'; tagline?: string }
  legal: Array<{ text: string; startSeconds: number }>
}
```

The `look` line is written once from tier and category. Premium means low-key light, shallow focus and slow moves. Mass means bright light, deep focus and saturated colour. Category adjusts it (for example, beauty gets soft, warm skin tones).

## 5. `plan_tvc` tool

Free (no generation, no approval card). Three actions:

- `check` (plan): validates the plan. On success it saves the plan file and returns `{ planFileId, cost }`, where cost reuses `check_credit_plan`'s estimate. On failure it returns a list of plain errors, for example "brand first appears at 4.0s; it must be on screen by 2.0s".
- `get` (planFileId, slice): returns only what one step needs (`brief+look`, `shots 4-6`, `finish`).
- `record` (planFileId, shot, stillFileId or clipFileId): writes a finished still or clip onto its shot and saves the plan. Progress lives in the plan, not in Olmo's working memory.

Blocking checks:

1. `brief.message` is one sentence of at most 12 words.
2. Shot durations sum exactly to `lengthSeconds`. Every shot is 1.2–2.5s, except the packshot (2–4s).
3. A shot with `brandVisible` starts before 2.0s.
4. For ads of 15s or less, a shot with `productVisible` starts by 3.0s.
5. Word caps across voiceover and lines: 6s ≤ 8, 15s ≤ 22, 20s ≤ 30, 30s ≤ 45.
6. The last voiceover word ends at least 2.0s before the end. Voiceover length is estimated at 2.7 words per second.
7. At most 2 on-camera lines. Each is in a medium or close-up shot, and its word count is at most `durationSeconds × 2.7`.
8. No voiceover block overlaps a line shot.
9. No two consecutive shots have the same `size`.
10. The last shot is the packshot, and `productPhotoFileId` is set.
11. At most 2 locations and at most 1 named actor. With no `actorAvatarId`, no shot has `audio: 'line'`.
12. Each on-screen text is at most 3 words, except the tagline and legal lines.

Warnings (returned with a successful check):

- India: every `mechanism` or `superpower` shot gets an automatic "Creative visualisation" legal line.
- India, food or beverage: the veg mark is required, but is not supported until Part 2; the warning says so, so the plan shows it to the user.
- Legal lines are held for the longer of 4s or (words ÷ 5) + 3s. This conservative rule stands until the ASCI documents are checked (Part 2).

## 6. Shots and clips

Per shot, in step 3:

1. `generate_video`, mode `animate_frame`, from the shot's approved still, with the `look` line in the prompt. The length is 3s, or for a line shot, the line's words ÷ 2.7 + 1s, at least 3s.
   - Silent shots: the prompt says that no one speaks. The clip keeps its own sound (fizz, splash, ambience).
   - Line shots: the line goes through `approvedDialogue`.
   - Hand-and-product actions are never shown in contact. They are cut as reach, then reaction, then result (Kuleshov).
2. `check_clip` with the actor reference, the product photo, and the line if there is one. Silent shots pass the new `expectNoSpeech: true`.
3. On failure, retry once. On a second failure, stop and show the shot to the user with the problem in one plain sentence ("the label is garbled in shot 5: redo or keep?").
4. `trim_clip` starting 0.5s in (skipping the warm-up morph), keeping `durationSeconds`. A line shot is trimmed around its line so no words are cut.
5. `plan_tvc record` the trimmed clip.

## 7. Finish

In order, in step 4:

1. **Packshot:** the last shot's clip, then `composite_end_card` with the real product photo.
2. **Join:** `assemble_clips` with `preserveAudio: true`, so the lines and sound effects stay.
3. **Voiceover:** `generate_narration` once per contiguous voiceover block (usually 1–2), in an announcer voice chosen from the tier and category.
4. **`mix_voiceover`** (new): places each block at its `startSeconds` and quiets the clips' own sound under it.
5. **Text:** `overlay_text` for shot text, the tagline on the packshot, and legal lines (static in Part 1).
6. **Music:** `generate_song` (instrumental), then `mix_music_bed` last.

The user gets one video. A single-shot redo regenerates, checks and trims that shot, records it, and then reruns finish steps 2, 4, 5 and 6. Narration is regenerated only if the script changed.

## 8. `mix_voiceover` tool

- Input: `videoFileId` (the joined video with its own audio), `blocks: [{ audioFileId, startSeconds }]`, `aspectRatio`.
- Behaviour: places each block at its start time; ducks the existing audio by about 8 dB under each block (sound effects stay audible) and restores it between blocks; masters the result. It refuses if a measured voiceover block comes out too quiet to hear, the same way `mix_music_bed` refuses an inaudible bed.
- Billing: charge first, refund on every failure path (the `mix_music_bed` pattern). A new credit rate `ffmpeg-mix-voiceover` is added to the rates seed.
- Approval: `shouldRequireApproval` with `resourceType: 'clip_assembly'`, like the other ffmpeg tools.

## 9. `check_clip` change

New optional input `expectNoSpeech: boolean`. When it is true, the clip fails if the audio transcription hears words. This is additive; existing callers are unchanged.

## 10. Discoverability and routing

Skills page: a new entry in `products/agent-platform/packages/api/seeds/official-skills.ts`:

- slug `tvc-ad`, name "TVC ad"
- file `official-skills/tvc-ad.md`; director `official-skills/tvc-ad/director.md` with marker `flow: tvc ad`
- best for: TV-style ads, Product launches, Brand films
- starter prompt: "Make a TV commercial for my product"
- showcase: a still from the first live test, swapped for the real example video once a live test passes

Olmo (`platformAgent.ts`), all additive:

- Pointer line: "For a polished TV-commercial style ad with several shots, voiceover, on-screen text and a product packshot, load the TVC ad skill with the skill tool and follow it."
- How it differs from the other ad skills: several polished shots and a packshot (TVC ad) versus one presenter in one continuous take (Talking head), the phone look (UGC character ad), or cartoon or animated (Animated story ad).
- The existing "talking-head or UGC?" question for an unclear ad type gains a third option: "TV commercial — polished shots, voiceover and packshot".
- A picked TVC avatar (currently `platformAgent.ts:517`, which routes to the presenter flows) routes to the TVC ad when that skill is on. The existing line stays as the fallback when it is off.
- An ambassador-style brief with no actor: offer the library's TVC actors or the TVC character creator. A mood-shift ad needs no actor.
- After the TVC character creator finishes, the existing suggestion contract may offer "make a TVC ad with this actor" as plain chat text, with no new UI.

Skill card (`tvc-ad.md`) contents: when to use it, the four steps, the questions it asks (aspect ratio always, plus anything it cannot infer, such as a missing product photo), and the plain-language rules (never say clip, shot list or beat to the user; show the plan in plain words; one finished video at the end). Every Director call carries `flow: tvc ad`, the plan fileId and the step.

`director.md` contents: how to write the look line, a prompt pattern for each shot type, product and label fidelity wording, the "no one speaks" wording for silent shots, the reach/reaction/result cut for hand actions, the trim rule for line shots, and the finish order.

## 11. Error handling

- `plan_tvc check` errors go back to Director, which fixes the plan and checks again. After two failed fixes, Director returns the remaining errors to Olmo, which asks the user in plain words.
- Clip failures: one retry, then the user decides (section 6).
- `mix_voiceover` and every ffmpeg step: charge first, refund on failure, and the step reports a plain reason.
- A refused generation (credits, moderation) stops the step. The plan keeps every recorded still and clip, so the next attempt resumes from there.

## 12. Testing

Unit:

- `plan_tvc`: one passing and one failing case for each blocking check; the warnings; `get` slices; `record` round-trip.
- `mix_voiceover`: ffmpeg arguments, block placement, ducking, every refund path, the too-quiet refusal (modelled on the `mix_music_bed` tests).
- `check_clip`: `expectNoSpeech` pass and fail.
- Seed test: the card, the `director.md` markers, the starter prompt.
- Olmo routing tests: the pointer line, the third option in the ad-type question, TVC avatar routing with the skill on and off.

Live (two runs, each checked against `mastra_span_events` traces):

1. Mood shift: a beverage, no actor, 15s, 16:9.
2. Ambassador spot: a beauty product with a library TVC avatar, 15s, 9:16.

Each passes when: the brand is visible by 2s, the same face appears in every shot, the label is correct, the voiceover ends before the packshot, and a single-shot redo works.

## 13. Deploy

- No database migration (the plan is a file).
- Seed the credit rates (`ffmpeg-mix-voiceover`) and the Official skills, then verify the skill's latest version and Director markers in the DB rather than trusting the seed log.
- Orchestrator `pm2 restart` on the VM (`deploy.sh` does not restart it).
- Lambdas are deployed only from the main checkout, never a worktree, if any Lambda code changes.

## 14. Part 2 (follow-ups, not in this spec)

1. Animatic preview: approved stills, voiceover and music cut into a cheap timed video before clip generation.
2. Text overlay upgrade: animated text, boxed legal text, veg mark and logo. HyperFrames (Apache-2.0) is the candidate, or an extension of `overlay_text`.
3. Sung jingle and sonic logo (needs a vocal music model; `generate_song` is instrumental only).
4. The actor's own voice for voiceover (voice cloning).
5. Verify the ASCI disclaimer rules and loudness targets against primary sources.
6. A claims summary for India's Self-Declaration Certificate.
7. Cutdowns: 30s to 15s to 6s.
8. The narrated-story format (Heinz-style).
