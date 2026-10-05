# TVC quality in the tools — design (Part 2, piece "quality")

Date: 2026-10-05
Status: draft for review (revised after the user-approved v5 test ad)
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
| Check design | **Narrow and high-res.** Each check is a set of small yes/no questions, one per full-resolution frame ("is a crown cap still on the bottle opening?"), driven by plan fields. It is never one big multi-part question on small frames. Proven on 2026-10-05: the broad checker (300px frames, many questions at once) passed a clip where the cap stayed on and missed a cloned face; the narrow checker caught both. |
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
| C2 | A lenient product check: plastic, a squat bottle and a silver cap all passed on Flash | The product comparison runs on **gemini-2.5-pro** with **5 full-resolution frames**, each frame asked separately with a short brand-manager question: material (glass vs plastic), shape and proportions, cap colour and type, label colour, logo text. A shot's expected state is passed in (e.g. "cap is off after the pop", "a hand may cover part of the label"), so normal action states are not failed. Round 3 of the test showed the strict check over-flagging a cap being popped and a hand over the label. | Unit: one call per frame; the question contains each attribute and the expected-state text; parse of each per-frame verdict. |
| C3 | A wide shot can't resolve the bottle's shape | New `productScale: 'close' \| 'medium' \| 'wide'` (from the shot size in the plan). For `wide`, only colour and label are judged, and shape and material are skipped. | Unit: the question for `wide` omits shape and material. |
| C4 | Duplicated objects (two vending machines, a stray child's face), invented text on props, CG smoke puffs, a flat graphic background where a real place is expected | These are added to the glitch list for every check, presenter and no-person alike. | Unit: question contains each item. |
| C5 | Empty background where the plan wants extras | New `expectExtras: boolean`. Fails when 2 or more of the sampled frames have no background people. | Unit: verdict counts. |
| C6 | The lead was cloned into the crowd: a background girl had the lead's face and hair in the last shot | New `leadFileId` (the lead's reference sheet). Per frame (3 frames, full resolution): "Ignore the main person. List every other person; for each, do they look like the lead (face, hair, skin tone, outfit)?" Any yes **fails** the clip, reporting where the lookalike is. The same question runs in `check_still`. | Unit: a verdict with one lookalike fails, with its location in the reason. Regression: the 2026-10-05 wide shot (lookalike on both attempts) fails. |
| C7 | The action never really happened: the cap flew off, but the bottle stayed capped for the rest of the clip | New `action` and `endState` (from the plan's shot fields). (a) Locate the action: one call across 8 time-labelled frames, "at which frame does <action> happen? null if never". (b) End state: the last 3 frames, asked separately, "is <endState> true?". (c) Physics: "does anything impossible happen (an object leaves but is still there, objects appear or vanish)?". Fails if the action never happens, the end state is false in any of the last frames, or physics fails. | Unit: each failure path. Regression: the 2026-10-05 opener clip (cap still on in all 3 final frames) fails; the two-shot macro pop passes. |
| C8 | A dead pause: the shot window began after the action, on a still-capped bottle | The C7 locate call returns `actionTime` in the tool output. `trim_clip`'s window for that shot is centred on it: `startSeconds = clamp(actionTime − 0.4 × durationSeconds, 0, clipLength − durationSeconds)`. Director uses the returned `trimStartSeconds` instead of the fixed 0.4s. | Unit: window maths at the clip's start, middle and end. |

### 3.3 New `check_still` (in `checkClip.ts`'s module, a separate tool)

This runs **before** a still is animated, and is the loop proven today: a squat bottle was fixed on retry, and a wide shot that failed twice was correctly held back.
- **Inputs:** `stillFileId`, `productFileId?`, `productScale`, `expectExtras`, `actorFileId?` (the lead).
- **Checks:** each is a separate narrow question on the full-resolution still: the Pro product question (C2–C3), each C4 glitch item, extras present (C5), the lead's face when an actor is given, and **lead cloned into the background** (C6).
- **Limit, proven 2026-10-05:** a still can pass the clone check and the clip still produce a lookalike, because Omni invents new extras while animating. So C6 runs again on the clip. After 2 failed clip attempts it stops and returns the shot to Olmo with the reason; it never loops.
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
| P3 | Empty hallway, and extras that look like the lead | Locations become objects: `{ name, extras?: string }`. A public place needs extras: a heuristic word list (school, hallway, street, office, market, cafe, station, mall, park), and when matched without extras, the plan check warns and Director must add them. Every shot prompt at that location includes the extras sentence, composed in code by a new `shotPromptFor(plan, n)` helper that the slice returns as `prompt`. With an actor, the helper always appends a **variety sentence**: extras have mixed hairstyles (short, curly, ponytails, buns), mixed clothing colours and builds, and none share the lead's look (her hair, her outfit colour). The lead's look comes from a new `brief.actorLook` (e.g. "long dark wavy hair, magenta shirt"). | Unit: helper output contains look, extras, the variety sentence excluding the lead's look, and camera grammar; the warning fires. |
| P4 | Flat, render-like product shots | Camera grammar by shot type, composed in `shotPromptFor`: product_macro gets "real lens, shallow depth of field, rack focus, real surfaces and reflections, never a flat graphic background"; hero, reaction and lifestyle get their own lines; every shot gets "no CG effects, no added text". | Unit: per-type text. |
| P5 | The product type didn't match the reference: a screw cap where the reference had a glass crown-cap bottle popped on an opener, which made the product read as plastic in every shot | Template recreation copies the reference's product **type** and changes only the brand. New optional `brief.reference: { productType: { material, closure, openedBy }, cutTimes?: number[] }`, filled from the reference's analysis. `brief.product` must declare the same `material`, `closure` and `openedBy`, or the plan check blocks with "the reference uses a glass crown-cap bottle opened on an opener; this product is a plastic screw-cap bottle". | Unit: mismatch error. |
| P7 | Actions and end states lived only in prose | Each shot gains `endState?: string` alongside `action` (e.g. action "cap pops off on the opener", endState "the bottle has no cap"). It is required when the action changes an object's state. The slice passes both to check_clip (C7). | Unit: validation requires endState for state-changing actions (a keyword list: open, pop, pour, bite, apply, peel, unwrap, cut). |
| P8 | A hard physical action in one shot failed: the cap flew while the bottle stayed capped | **Revised after v4/v5 (user: v4 "so bad… weird jump cuts").** Splitting the opener into two tiny shots (0.40s + 0.48s) from almost the same angle made a jump cut. The rule is now: keep a hard action (open, pop, pour, bite, apply, peel, unwrap, cut) as **one shot, gated by C7** (action + end state). The clip that fails is returned to the user, never used. In v5 the single opener passed C7 on the first try, with the cap popping at 1.67s, trimmed around it by C8. A split is allowed only when the second shot is a **clearly different angle and size** (e.g. wide setup → macro result). The plan check blocks a split whose two shots share a size or angle. | Unit: a split with two close-ups from the same angle is blocked; a single hard-action shot passes validation and requires `endState`. |
| P9 | Jump cuts from micro-shots and near-identical consecutive framings | Plan check: every shot is ≥ 0.6s unless marked `flashCut: true`; consecutive shots must differ in **angle** (new shot field `angle: 'eye' \| 'low' \| 'high' \| 'top' \| 'side' \| 'pov'`), not only in size. A shot with `continuesFrom` is exempt (it is one continuous action) but must be trimmed **from 0**, since its first frame *is* the previous clip's last frame. Trimming it from 0.4s made the drop → grab join jump in v4. | Unit: a 0.4s shot is blocked; two consecutive shots with the same angle and size are blocked; the continuing shot's slice says `trimStartSeconds: 0`. |
| P10 | The ending had no energy: "does one twirl" produced only walking | The payoff shot's `action` is checked by C7 like any action (e.g. "dances and spins all the way around once"). In v5 the gated version passed on the first try. `shotPromptFor` writes payoff actions as concrete, physical, checkable moves, never mood words alone. | Unit: a payoff shot without a concrete action verb gets a plan warning. |
| P6 | Shot timings were guessed, not taken from the reference | When recreating, Olmo or the template flow detects the reference's real cuts (ffmpeg `select='gt(scene,0.25)'`, a new free helper `detect_cuts` in `analyze_video`'s module) and stores them in `brief.reference.cutTimes`. The plan check then requires shot boundaries within ±0.15s of them. | Unit: boundary check; helper parses showinfo output. |

### 3.6 `overlay_text` and `composite_end_card`: keep text off faces

| # | Defect | Change | Test |
|---|---|---|---|
| O1 | The "bubbli" end card sat right over the lead's face | New optional `avoidFaces: boolean` (default true for TVC tagline and end card). Before compositing, the tool asks Gemini on 2 full-resolution frames inside the overlay's time window for face bounding boxes. It then picks the first of `top`, `center`, `bottom` (or, for the end card, a left or right third) whose text box doesn't overlap any face. If none fit, it shrinks to `small` and places at `top`. The chosen position is returned. | Unit: placement choice for given face boxes; the fallback path. |

### 3.7 Skill text (thin pointers only)

`tvc-ad/director.md` changes from rules to tool names:
- the stills step calls `check_still`;
- the clips step uses the slice's `prompt`, `generateSeconds`, `productFileId` and continuity flag;
- check_clip gets `productMustBeVisible`, `productScale`, `expectExtras`, `leadFileId`, `action` and `endState` straight from the slice;
- trim_clip uses the returned `trimStartSeconds` (C8).

All edits are additive to the TVC files only.

### 3.8 Already fixed / not a product defect

- **The end card showing for one frame** was the test script only; `composite_end_card` already uses `-loop 1`. The future logo/text-card overlay (the text-overlay piece) must follow the same pattern; this is noted there.
- **The zsh 1-based arrays and the wrong GCP project** were test-harness mistakes, recorded in memory.

## 4. Part B — the jingle (next piece, outline only)

- The gateway allows `lyria-3-clip-preview` (location global, `generateContent`, `responseModalities: ["AUDIO","TEXT"]`) and returns MP3 + timed lyrics.
- `generate_jingle` ($0.04 rate) returns the jingle, the timed lyrics and a sign-off cut. The cut runs from the line's start to the first silence after its end (silencedetect −35dB), with a 0.9s fade.
- The plan's `brief.jingle`. The sign-off ends with the ad, and its start is at least 0.75s after the last speech (check).
- `mix_voiceover` blocks gain `kind: 'voice' | 'jingle'`. A jingle block is level-matched to the base's measured loudness in the 5s before it (target base +2 LU when there is no speech, equal to speech otherwise). Measured today: unmatched it was 8 LU too loud.

## 5. Error handling

- Every new refusal or failed check has a plain reason Director can act on: DURATION_MISMATCH, CONTENT_BLOCKED, STILL_NOT_CHECKED, REFERENCE_PRODUCT_MISMATCH, HARD_ACTION_NOT_SPLIT, LEAD_CLONED (with where), ACTION_NOT_COMPLETED (with the end state that was false).
- Paid steps keep charge-first and refund-on-failure.
- check_still and the new check_clip calls are free. If the Pro call fails, retry once with the same inputs; then report "unchecked" plainly, never a pass.

## 6. Testing

- **Unit:** every row above has its test (listed in the tables).
- **Regression fixtures** (saved as small test clips with expected verdicts): the 2026-10-05 opener whose cap stayed on (C7 must fail), the wide shot with a lookalike extra (C6 must fail), the shot-9 clip where the bottle vanished (C1 must fail), the two-shot macro pop (C7 must pass). These run against the real Pro model in a tagged test that is excluded from the default suite.
- **Real ffmpeg check:** for A1–A3, join four 24fps Omni-like clips. The output is 24fps, its duration equals the sum ±0.1s, and the fades are present.
- **Live test through the product:** remake the Bubbli recreation of the Coca-Cola PH ad (16:9, 14.8s, the reference's cut times) on the VM:
  - with a glass, crown-cap Bubbli bottle;
  - checked against the strict check on every product shot;
  - side by side with the reference.

  The target result is the user-approved hand-built v5 (`~/Desktop/coke-recreation-test/7-BUBBLI-TVC-v5.mp4`, "yes this one is great now"). The product run passes when every product shot passes C1–C3 on the first or second attempt, no shot fails C6 (lead clone), the opener is one shot that passes C7 with no jump cut, the ending's dance and spin passes C7, every action shot is trimmed around its action (C8), the end card avoids the lead's face (O1), the hallway has extras, the grab shot continues from the drop shot's last frame, and playback is smooth (24fps, no drift).

## 7. Deploy

- Orchestrator `pm2 restart`.
- Gateway `pm2 restart inference-gateway` (V1, V2).
- The checks add Gemini Pro calls (about 15–25 per 15s ad). They are free to the user; cost is logged via `persistCost`.
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
