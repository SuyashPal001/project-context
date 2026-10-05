# TVC quality in the tools — design (Part 2, piece "quality")

Date: 2026-10-05
Status: draft for review
Builds on: `2026-10-05-tvc-ad-design.md` (Part 1, branch `tvc-ad-spec`, unmerged)
Evidence: hand-built test ads on the product stack (gemini-3-pro-image + Omni on `excellent-setup-486815-c1`): "Chai Nation" and "Bubbli", a recreation of the Coca-Cola PH school ad. Files: `~/Desktop/coke-recreation-test`, `~/Desktop/jingle-test`. Memory: `project_tvc_quality_tool_fixes.md`.

## 1. Goal

Every defect found in today's test ads is caught or prevented by **tool code**, not by skill text. The user's rule: "make sure you are making it like tools, so these issues are not just depended on prompt". When a defect still gets through generation, a tool refuses or fails a check with a plain reason. It is never left to the model to notice.

**Success:** remaking the Bubbli ad *through the product* (not by hand) produces:
- smooth playback (no judder, no drift, no audio jumps at cuts);
- the same glass bottle in every product shot;
- busy backgrounds where the plan asks for them;
- no teleporting objects;
- no invented text or CG effects;
- every failure caught by a check before the user pays for the next step.

## 2. Decisions

| Decision | Choice |
|---|---|
| Where fixes live | In tool code (assemble_clips, check_clip, generate_video, plan_tvc, tvcPlan) and in prompt text composed by code from plan fields. Skill text only names the tools. |
| Check model | Product and still checks use **gemini-2.5-pro**. Flash passed bottles that Pro correctly failed (plastic vs glass, cap colour). Presenter checks stay on the current model. |
| Checks cost | Free to the user, the same as check_clip today. A retry of a failed *still* is one more paid image, inside the shot's already-approved plan cost. A retry of a failed *clip* stays the user's choice (main's bef66922 rule). |
| Default video mode for product shots | Start frame + product photo through Omni `reference_to_video`, start still first (new `productFileId` on `animate_frame`). Plain image_to_video drifted glass to plastic even from a passing still. |
| Split | **Part A (this plan):** assembly, checks, plan fields, video anchoring. **Part B (next piece):** the jingle (`generate_jingle`, gateway route for `lyria-3-clip-preview`) and its mix rules, which reuse Part A's measured mixing. |

## 3. Part A — changes per tool

### 3.1 `assemble_clips` (`assembleClips.ts`)

| # | Defect | Change | Test |
|---|---|---|---|
| A1 | Judder: every clip forced to 30fps (line 283 `fps=30`), but Omni outputs 24fps | Probe each input's `r_frame_rate`. If all inputs share one rate, keep it. Otherwise use the most common rate, never upsample 24→30. The output rate is returned as `fps`. | Unit: filter graph for 24fps inputs has no `fps=30`; mixed inputs choose the majority. |
| A2 | Drift: the joined video ran 17.9s for 14.8s of pieces | Reset timestamps per input (`setpts=PTS-STARTPTS`, `asetpts`) before concat. After encoding, ffprobe the output; refuse `DURATION_MISMATCH` (with refund) if it differs from the sum of the inputs by more than 0.1s. | Unit: the refusal path with a stubbed probe; graph contains the timestamp resets. |
| A3 | Audio jumps at every cut | With `preserveAudio`, add a 40ms `afade` in and out at each input's edges. New optional `roomTone: boolean` lays a continuous low brown-noise bed (lowpass 700Hz, about −42 dBFS) under the joined audio. | Unit: filter graph contains the fades; roomTone adds the bed input. |

### 3.2 `check_clip` (`checkClip.ts`)

| # | Defect | Change | Test |
|---|---|---|---|
| C1 | A vanished product passed: "product_same true if it is not visible" | New `productMustBeVisible: boolean` (from the plan's `productVisible`). It fails when the product is missing in any sampled frame. The re-check guard tracks it, so it can't be dropped. | Unit: a verdict with visible=false in one frame fails; guard refuses dropping it. |
| C2 | A lenient product check: plastic, a squat bottle and a silver cap all passed on Flash | The product comparison runs as a separate **gemini-2.5-pro** call with a brand-manager question: material (glass vs plastic), shape and proportions, cap colour and type, label colour, logo text. **5 frames** are sampled across the clip instead of 3. | Unit: question text contains each attribute; parse of a per-frame JSON verdict. |
| C3 | A wide shot can't resolve the bottle's shape | New `productScale: 'close' \| 'medium' \| 'wide'` (from the shot size in the plan). For `wide`, only colour and label are judged, and shape and material are skipped. | Unit: the question for `wide` omits shape and material. |
| C4 | Duplicated objects (two vending machines, a stray child's face), invented text on props, CG smoke puffs, a flat graphic background where a real place is expected | These are added to the glitch list for every check, presenter and no-person alike. | Unit: question contains each item. |
| C5 | Empty background where the plan wants extras | New `expectExtras: boolean`. Fails when 2 or more of the sampled frames have no background people. | Unit: verdict counts. |

### 3.3 New `check_still` (in `checkClip.ts`'s module, a separate tool)

This runs **before** a still is animated, and is the loop proven today: a squat bottle was fixed on retry, and a wide shot that failed twice was correctly held back.
- **Inputs:** `stillFileId`, `productFileId?`, `productScale`, `expectExtras`, `actorFileId?`.
- **Checks:** the same Pro product question as C2–C3, the C4 glitch list, C5, and the actor's face when an actor is given.
- **Output:** `passed` and `reason`.
- **Loop:** `director.md` (TVC step "stills") says: on fail, generate the still once more with the reason appended; on a second fail, return it to Olmo with the reason. Only stills that passed (or were kept by the user) get recorded. `plan_tvc record` refuses a still without a passing `check_still` in the same conversation (tracked in memory, like check_clip's re-check map), unless `keptByUser: true`.
- **Test:** the record refusal without a passing check, and the verdict parsing.

### 3.4 `generate_video` (`generateVideo.ts`) + gateway (`video.ts`)

| # | Defect | Change | Test |
|---|---|---|---|
| V1 | Omni drifts glass to plastic in image_to_video, even from a passing still | `animate_frame` gains optional `productFileId`. When set, the gateway sends Omni `reference_to_video` with `[start still, product photo]` (start still first, as verified today), not image_to_video. The prompt prefix is composed in code: "The first image is the exact opening frame; the second is the exact product, which stays unchanged and visible." | Unit: the request body has task `reference_to_video` and the image order; the prefix is present. Gateway unit: two image parts in order. |
| V2 | A content block (e.g. "high-school girl … spin") came back as a generic failure | Map Omni's `content_blocked` to `refusalReason: 'CONTENT_BLOCKED'` with the plain text "rephrase the shot (no ages or minors' activities)", and refund. | Gateway and tool unit. |

### 3.5 Plan (`tvcPlan.ts`) and `plan_tvc`

| # | Defect | Change | Test |
|---|---|---|---|
| P1 | The last shot is too short: a 3s clip trimmed from 0.4s can't fill 3.1s | Each shot in a slice carries a computed `generateSeconds = clamp(ceil(durationSeconds + 0.4 + 0.3), 3, 10)`, plus the line rule for line shots. Director uses it as is. | Unit: slice values for 1.2, 2.5, 3.1 and 4s shots. |
| P2 | Teleporting objects: the bottle went from lying in the tray to floating in her hand | New shot field `continuesFrom?: number` (the previous shot's number). Validation: it must be the immediately previous shot, at the same location. The slice says so, and the clips step makes that shot's start frame with `extract_frame` (at "last") from the recorded clip of the shot it continues. `record` refuses a still for a continuing shot (its start frame comes from the clip). | Unit: validation errors; slice flags `startFromPreviousLastFrame`. |
| P3 | Empty hallway | Locations become objects: `{ name, extras?: string }`. A public place needs extras: a heuristic word list (school, hallway, street, office, market, cafe, station, mall, park), and when matched without extras, the plan check warns and Director must add them. Every shot prompt at that location includes the extras sentence, composed in code by a new `shotPromptFor(plan, n)` helper that the slice returns as `prompt`. | Unit: helper output contains look, extras and camera grammar; the warning fires. |
| P4 | Flat, render-like product shots | Camera grammar by shot type, composed in `shotPromptFor`: product_macro gets "real lens, shallow depth of field, rack focus, real surfaces and reflections, never a flat graphic background"; hero, reaction and lifestyle get their own lines; every shot gets "no CG effects, no added text". | Unit: per-type text. |
| P5 | The product type didn't match the reference: a screw cap where the reference had a glass crown-cap bottle popped on an opener | New optional `brief.reference: { productType: { material, closure, openedBy }, cutTimes?: number[] }`. When set, `brief.product` must declare the same `material`, `closure` and `openedBy`, or the plan check blocks with "the reference uses a glass crown-cap bottle opened on an opener; this product is …". | Unit: mismatch error. |
| P6 | Shot timings were guessed, not taken from the reference | When recreating, Olmo or the template flow detects the reference's real cuts (ffmpeg `select='gt(scene,0.25)'`, a new free helper `detect_cuts` in `analyze_video`'s module) and stores them in `brief.reference.cutTimes`. The plan check then requires shot boundaries within ±0.15s of them. | Unit: boundary check; helper parses showinfo output. |

### 3.6 Skill text (thin pointers only)

`tvc-ad/director.md` changes from rules to tool names:
- the stills step calls `check_still`;
- the clips step uses the slice's `prompt`, `generateSeconds`, `productFileId` and continuity flag;
- check_clip gets `productMustBeVisible`, `productScale` and `expectExtras` straight from the slice.

All edits are additive to the TVC files only.

### 3.7 Already fixed / not a product defect

- **The end card showing for one frame** was my test script only; `composite_end_card` already uses `-loop 1`. The future logo/text-card overlay (the text-overlay piece) must follow the same pattern; this is noted there.
- **The zsh 1-based arrays and the wrong GCP project** were test-harness mistakes, recorded in memory.

## 4. Part B — the jingle (next piece, outline only)

- The gateway allows `lyria-3-clip-preview` (location global, `generateContent`, `responseModalities: ["AUDIO","TEXT"]`) and returns MP3 + timed lyrics.
- `generate_jingle` ($0.04 rate) returns the jingle, the timed lyrics and a sign-off cut. The cut runs from the line's start to the first silence after its end (silencedetect −35dB), with a 0.9s fade.
- The plan's `brief.jingle`. The sign-off ends with the ad, and its start is at least 0.75s after the last speech (check).
- `mix_voiceover` blocks gain `kind: 'voice' | 'jingle'`. A jingle block is level-matched to the base's measured loudness in the 5s before it (target base +2 LU when there is no speech, equal to speech otherwise). Measured today: unmatched it was 8 LU too loud.

## 5. Error handling

- Every new refusal has a plain reason Director can act on: DURATION_MISMATCH, CONTENT_BLOCKED, STILL_NOT_CHECKED, REFERENCE_PRODUCT_MISMATCH.
- Paid steps keep charge-first and refund-on-failure.
- check_still and the new check_clip calls are free. If the Pro call fails, retry once with the same inputs; then report "unchecked" plainly, never a pass.

## 6. Testing

- **Unit:** every row above has its test (listed in the tables).
- **Real ffmpeg check:** for A1–A3, join four 24fps Omni-like clips. The output is 24fps, its duration equals the sum ±0.1s, and the fades are present.
- **Live test through the product:** remake the Bubbli recreation of the Coca-Cola PH ad (16:9, 14.8s, the reference's cut times) on the VM:
  - with a glass, crown-cap Bubbli bottle;
  - checked against the strict check on every product shot;
  - side by side with the reference.

  It passes when every product shot passes C1–C3 on the first or second attempt, the hallway has extras, the grab shot continues from the drop shot's last frame, and playback is smooth (24fps, no drift).

## 7. Deploy

- Orchestrator `pm2 restart`.
- Gateway `pm2 restart inference-gateway` (V1, V2).
- No migration; no new rates in Part A.
- Official-skills seed for the director.md changes, then verify the DB row.

## 8. Not in this piece

- The jingle build (Part B, next).
- The text-overlay upgrade (animated text, boxed legal text, logo/veg mark).
- The animatic.
- The voice clone.
- Changing the check model for presenter flows (talking-head, UGC).
- Automatic paid clip redo (stays the user's choice).
- Lyria 3.5 (Gemini API only).
