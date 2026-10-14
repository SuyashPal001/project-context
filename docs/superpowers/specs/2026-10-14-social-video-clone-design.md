# Social video clone: break down any reel and remake it for a brand

Date: 2026-10-14
Status: design, written from a hands-on spike (2026-10-11 to 2026-10-14)
Spike notes: memory `project_template_clone_spike.md`; throwaway scripts in the session scratchpad (`vtools.py`, `break_down_video.py`, `gen.py`, `compose*.py`, `check_*.py`, `rem/`)

## 1. Goal

A user pastes a social video link (or uploads a file) and says "make this for my brand". The agent:

1. fetches the video,
2. breaks it down completely (story, moments, poses, movement, props, setting, the trick and its timing),
3. writes a remake plan where every element of the breakdown is kept, swapped or dropped,
4. gets the user's approval on the plan and its cost,
5. generates the remake,
6. checks the remake automatically against the reference and fixes what it can,
7. delivers the video with a short "what differs from the reference" note.

The user only approves the plan and receives the final. Everything that was checked by hand in the spike becomes tool code.

Non-goals for v1: TikTok links (blocked from India), cloning long videos end to end (the user picks a segment first), copying the original music, recreating a real person's face.

## 2. What the spike proved

| Step | Result | Evidence |
|---|---|---|
| Fetch | `yt-dlp` logged-out works for YouTube, Instagram (most posts), X, Facebook, LinkedIn (short links too). TikTok is unreachable from India, including our VM (asia-south2) and Lambdas (ap-south-1); its CDN too. | 5 real links downloaded |
| Watch | Gemini on the whole video plus audio is about 11x cheaper than frames as images (60s ad: 6,300 tokens vs 67,200) and hears the sound. Vertex reads a YouTube URL directly (`fileData.fileUri`). | countTokens and generateContent runs |
| Model | `gemini-3.8-flash`, thinking LOW, was best: right on fast shots, about $0.03 per minute. 3.1 Pro was 3x the cost and no better. GPT (Codex) is the most accurate on stills but has no audio or motion, so it is the picture checker. | 4-model comparison on the Sony ad |
| Cuts | TransNetV2 (CPU) gave the cleanest hard cuts plus fades. No cut detector finds hidden cuts behind an object. A look-matching method (OpenCV) found the fan reel's outfit changes to the frame. | 4 videos |
| Sound | Every Gemini model got sound timing wrong by about 3s. A per-half-second loudness curve from ffmpeg is exact and free. | Sony ad |
| Remake | 12 iterations of a 15s fan reel. Each failure became a rule (section 7). Final v12 matched story, poses, leg alternation, face, props and fan rhythm. | `~/Desktop/noor_thread_fan_reel_v12.mp4` |
| Veo | Veo 3.1 first+last frame is good at moving between two poses. It cannot follow a near-lens one-blade sweep (it shrinks the fan, pops the change). It blocked one face 3 times (image-triggered). | 6 Veo runs |

## 3. User flow (agentic, no new UI)

1. User: link or upload, plus brand and product details (photos optional).
2. Agent calls `break_down_video` and replies in chat with a short summary: format, the trick, the story in one line.
3. Agent calls `plan_remake` and shows the plan: each look/shot with keep/swap/drop, the cast (a 3-option casting sheet when a person is on screen), and the cost. The user approves or edits in chat.
4. Agent calls `make_remake`. Progress events stream into the chat.
5. The tool runs every check, retries failures once automatically, and returns the video plus a difference note. Anything still failing is listed plainly, never presented as fine.

This is an Official skill (the existing `template-video` skill grows into it, append-only per our skill rule). The choices go to the agent asking in chat, never to new on-screen menus.

## 4. Architecture

```
agent-orchestrator (Mastra tools, Node)        ai-service (FastAPI :3004, Python, VM)
  fetch_video  ── yt-dlp, ffmpeg ──────────┐     /cuts          TransNetV2
  watch_video  ── gateway → Gemini         │     /hidden-cuts   OpenCV look matching
  find_cuts    ── ai-service /cuts ────────┼──►  /occluder      blade mask + coverage curve
  find_hidden_cuts ── ai-service ──────────┘     /sound         ffmpeg loudness curve
  sound_timeline ── ai-service /sound            /compose       edge-reveal matte compositor
  describe_shots ── gateway → Gemini
  check_* ────── gateway → Gemini / GPT
  break_down_video (composite)
  plan_remake / make_remake (composites)
inference-gateway: Gemini (watch, checks), Nano Banana Pro (stills), Omni + Veo 3.1 (clips)
Remotion: overlay layers only (PNG sequence); system ffmpeg composites (Remotion's bundled ffmpeg needs macOS 15)
```

Reuse, don't duplicate:
- `detectCuts.ts` (ffmpeg scene filter) is kept for the TVC flow; `find_cuts` uses TransNetV2 because it drops flash false-cuts and finds fades.
- `checkClip.ts` / `checkStill.ts` / `tvcChecks.ts` already have the pattern we need (`CheckUnavailableError`, one retry, return to Olmo on a second fail). The new checks follow it and share its helpers.
- `analyze_video` today sends 8/20 evenly spaced frames with no audio. It is replaced by the whole-video Gemini call (`watch_video`), and `analyze_video` becomes a thin wrapper over it.
- `generate_video`, `assemble_clips`, `mux_beat_audio`, `overlay_text` stay as they are; `make_remake` calls them where they fit.
- The gateway gains Veo 3.1 first+last frame (`lastFrame`, `veo-3.1-generate-001`, us-central1, `predictLongRunning` + `fetchPredictOperation`). Today it only has a dormant Veo 2 path.

Lambda is not used for any of this (no ffmpeg, size and time limits). Everything heavy runs on the VM.

## 5. Tools

Every tool below is a separate Mastra tool. The composites call them in order; the agent can also call any one alone for follow-ups ("recheck 40-45s", "just the sound").

### 5.1 Fetch

`fetch_video({ url | fileId })` returns `{ fileId, durationS, width, height, fps, hasAudio, caption, author, youtubeUrl? }`.
- `yt-dlp` logged-out only, with `-S "vcodec:h264,res:1080,acodec:m4a"`; if the stream is not H.264, convert with ffmpeg (a 15s reel takes 1.6s).
- YouTube: also keep the URL so Gemini reads it directly.
- Instagram post blocked, or TikTok: tell the user plainly and ask for an upload. Never fetch with a logged-in account.
- Over 90s: return a cheap segment map and ask which part to clone.
- `yt-dlp` is pinned and updated on a schedule; fetch failures are logged by platform.

### 5.2 Breakdown

`watch_video` (Gemini 3.8 Flash, LOW thinking, whole video plus audio, fps 4 if 30s or less, 2 if 90s or less, else 1) returns the overview in section 6. Rough times only.

`find_cuts` (TransNetV2, threshold 0.5) returns hard cuts plus fade spans.

`find_hidden_cuts` runs only when `watch_video.change_style` has `hidden_changes`. It matches every frame to one reference frame per look (inside `subject_box`), marks frames that match no look as covered, and puts the switch in the middle of the covered gap. It requires at least 0.3s of a stable look before counting a switch.

`find_occluder` (new, from the fan lesson) segments the covering object per frame and returns its coverage curve, pivot and sweep direction. The remake replays this curve, not just the switch times.

`sound_timeline` returns per-0.5s loudness, big jumps/drops, a summary of rhythmic patterns (repeated ticks become one entry), and silent-from.

`describe_shots` (Gemini) gets the exact boundaries from the tools above and the measured sound events, and labels every shot. Shots the model skips are filled as "unclear" so nothing disappears.

`check_short_shots` (GPT, stills) checks shots under 1s. It may correct the subject; the action and motion stay Gemini's (GPT cannot see motion). It is ignored on fade or transition frames.

`break_down_video` composes all of the above and returns the breakdown in section 6.

### 5.3 Plan

`plan_remake({ breakdown, brand })` returns the plan in section 6.2. Every item in the breakdown appears in the plan as keep, swap (to what) or drop (why). Prompts are generated FROM plan lines, never written freehand.

When a person is on screen, the plan includes a casting step: a 3-option casting sheet (one image, about Rs 11) and the user picks one.

### 5.4 Generate

For each look:
1. **Start still:** made from the cast portrait, the setting and the outfit. The pose comes from the matching reference frame used as a pose-only guide ("copy only the pose; not the person, outfit, setting or text").
2. **End still** when the look has movement (pose changes during the look).
3. **Clip:** start still plus a movement prompt built from the breakdown's moves (times, limbs, image-left/right directions). When an end still exists, Veo 3.1 first+last frame; fallback Omni `image_to_video` on a content block. Looks with no movement use Omni.
4. **Continuity edits** before animating (for example "the remote lies on the rug at the left in every look").

The trick comes from the recipe library (section 9). For v1 that is the occluder edge-reveal recipe.

`make_remake` runs the per-look steps in parallel, runs the checks (section 8) after every still and every clip, retries a failed item once with the check's reason added, then composes and runs the final checks.

## 6. Data shapes

### 6.1 Breakdown (output of `break_down_video`)

```jsonc
{
  "video": { "durationS": 14.9, "width": 1080, "height": 1920, "fps": 30, "caption": "...", "source": "..." },
  "format": "overhead fan-wipe outfit change",
  "layout": "full frame | split screen | ...",
  "story": { "setup": "...", "cause": "...", "payoff": "..." },
  "setting": { "floor": "...", "rug": "...", "furniture": "...", "light": "...", "subjectFillPct": 70 },
  "looks": [{
    "id": 1, "startS": 0, "endS": 5.4,
    "outfit": { "pieces": "...", "colours": "...", "fabric": "...", "details": "..." },
    "expression": "mouth closed, poised, steady gaze into lens",
    "startPose": "...", "endPose": "...",
    "moves": [{ "tS": 3.0, "limb": "legs", "direction": "image-right", "how": "slide feet sideways along the rug" }],
    "legSide": "right",
    "referenceFrames": { "start": 0.5, "end": 4.6 }
  }],
  "moments": [{ "tS": 1.25, "what": "points remote up at the fan", "why": "switches the fan on: the cause of the story" }],
  "props": [{ "prop": "black remote", "where": "rug, left of her hand", "when": "all looks after 2.2s" }],
  "trick": {
    "recipe": "occluder_edge_reveal",
    "occluder": { "kind": "ceiling fan blade", "pivot": "top-left corner", "direction": "clockwise", "sharp": true, "sizePctOfFrame": 45 },
    "coverageCurve": [/* per-frame 0..1 */],
    "switches": [{ "fromLook": 1, "toLook": 2, "atS": 5.0 }]
  },
  "shots": [/* describe_shots output with exact boundaries */],
  "sound": { "music": { "mood": "...", "genre": "...", "instruments": "...", "hasVocals": true, "bpm": 105, "beatsS": [], "songName": null, "artist": null }, "voice": null, "events": [], "rhythm": [], "silentFromS": null },
  "onScreenText": [{ "text": "...", "style": "...", "persistent": true }],
  "keep": [], "swap": [], "neverCopy": ["the music track", "the person's face", "logos", "verbatim script"]
}
```

### 6.2 Remake plan (output of `plan_remake`)

```jsonc
{
  "cast": { "castingSheetFileId": "...", "chosen": 2, "portraitFileId": "..." },
  "lines": [
    { "ref": "looks[1].outfit", "action": "swap", "to": "brand product: ..." },
    { "ref": "moments[0]", "action": "keep" },
    { "ref": "sound.music", "action": "swap", "to": "new instrumental, same mood" },
    { "ref": "onScreenText[0]", "action": "swap", "to": "brand caption" }
  ],
  "looks": [{ "id": 1, "startStill": "...", "endStill": "...", "clip": { "model": "veo-first-last | omni", "seconds": 6, "prompt": "built from lines" } }],
  "trick": { "recipe": "occluder_edge_reveal", "params": { "coverageCurve": "from breakdown", "switches": "from breakdown" } },
  "costEstimateRs": 300
}
```

## 7. Generation rules (each one came from a failure in the spike)

1. **Add nothing the reference doesn't have.** No invented effects (a darkening flicker was added once) and no invented expressions (smiles were added once).
2. **Prompts come from plan lines,** never from Claude's own summary. (The remote "hook" was lost once this way.)
3. **An action may only reference an object visible at that spot in the start frame.** (She once pinched empty air "touching the dupatta".)
4. **Pose from pictures, not words.** Words produced stiff, symmetric poses. Check for over-amplification: a slight leg angle was once turned into a whole-body tilt.
5. **Never freeze a mid-movement reference frame as a static pose.** Model each look as a start pose plus moves to an end pose. (Look 3 looked "slanted" because a mid-swing frame was frozen.)
6. **Directions are image-left/right,** and leg side is tracked per look. (The reel alternates right/left/right/left.)
7. **Identity lock:** every still edit gets the cast portrait plus the first approved frame as face references.
8. **Mechanical motion comes from one shared angle track** at steady speed. No per-segment easing (the fan once stopped at every peak). The overlay and the matte read the same track, so they cannot drift apart.
9. **Replay the occluder's measured coverage curve,** not just the switch times. (The fan was "on/off" when only switch times were used.)
10. **Continuity is checked on CLIPS, not just stills.** The video model added a second remote, lost it, and moved it.
11. **Video-model fallback chain:** Veo first+last, then Omni single-image, on a content block. Retry a block once with plainer wording before falling back.
12. **Keep exact frame counts:** convert each clip to 30fps first, then trim by frame number. (A 24 to 30fps trim drifted 0.17s.)

## 8. Automatic checks

Run on every still, every clip and the final video. Each returns pass / fail / unknown with evidence frames.

| Check | Method | Pass |
|---|---|---|
| Prop count and place | Gemini counts props every 0.5s | exact count in every frame |
| Same person | Gemini same-person score against a same-angle frame | 8/10 or more |
| Expression | face crop pair, reference vs remake at the same moment | same mouth, eyes and mood |
| Pose and leg side | Gemini at measured times; knees and feet judged separately | matches the breakdown |
| Body axis/centre | the pose check also compares body angle and frame centre | within tolerance |
| Empty-hand action | Gemini on the clip: does a hand interact with nothing? | none |
| Brightness jumps | whole-frame mean, frame to frame | same count as the reference (usually 0) |
| Occluder rhythm | coverage-curve correlation with the reference | 0.7 or more |
| Story | breakdown of the remake vs the reference: missing or extra moments | nothing missing |

Checker rules:
- **A checker with no data reports UNKNOWN and never passes.** (A crash "fix" once turned an empty answer into PASS.) Parsers accept a bare list or an object.
- **Sample at MEASURED times,** never at Gemini's rough times. (The first verifier flagged correct timing as wrong because it sampled about 1s early.)
- **Every claim comes with its evidence frames.** Never auto-fix from an unverified claim: the first verifier also invented "the remote is hidden".
- **One automatic retry** with the check's reason added; on a second failure, report it to the user.

## 9. Trick library

Most viral videos reuse a small set of mechanics. Each recipe is parameterised code plus its required assets plus its own check:

| Recipe | v1? | Notes |
|---|---|---|
| `occluder_edge_reveal` (fan, door, hand wipe) | yes | built in the spike: the swap matte follows the occluder edge; the overlay is driven by the shared angle track |
| hard-cut montage (Sony type) | yes | exact cuts from `find_cuts`, joined with `assemble_clips` |
| near-still animated poster (LinkedIn type) | yes | one still plus light motion; no full video generation |
| split-screen reaction (Facebook type) | later | layout plus two sources |
| whip pan, match cut, zoom transition, text pop | later | one recipe each |

`watch_video` classifies the trick into a recipe and `find_occluder` / `find_cuts` measure its parameters. An unknown trick is told to the user plainly ("this effect isn't supported yet") and logged so we can add a recipe.

**The occluder's look is the weak point.** A 2D cut-out blade drawn in Remotion reads as a sticker, and AI video (Veo) won't produce a near-lens one-blade sweep. The fix is real filmed plates: a ceiling fan shot from below on a phone, luma-keyed against the white ceiling, plus a small licensed set (door, hand). Plates are shot or bought once and reused by every user.

## 9a. Music

The original song is never put in our file. Instagram's label licences cover in-app, personal, non-commercial use only; business accounts only get the Meta Sound Collection; and the official publishing API cannot attach library music. Third-party "audio_id" attach services use unofficial routes and are not used.

- **Breakdown (phase 1) records the music facts:** mood, genre, instruments, vocals yes/no, tempo (BPM), beat times, and the song name/artist only when the platform's metadata or on-screen text gives it (never guessed).
- **Option 1 (phase 3), default:** new music generated to match the mood, genre and tempo, with the edit cut on its beats.
- **Option 2 (phase 3), optional:** a second export timed to the reference's beats, with a "music slot" note: "the original uses <song>; on a personal or creator account you can add it in Instagram when posting." Business accounts are told plainly it isn't allowed for them and are pointed to the Meta Sound Collection.
- **Decided (2026-10-14):** no paid stock-music library (Epidemic Sound / Artlist / Soundstripe). Music in the file is always generated (Lyria, or another song generator if quality needs it).

## 10. Cost and time (15s reel, 4 looks)

| Item | Rs |
|---|---|
| Breakdown (watch + describe + checks) | about 5 |
| Casting sheet | 11 |
| Stills: 4 looks + 1-2 end stills + about 2 continuity fixes | about 80 |
| Clips: 1 Veo 6s + 3 Omni | about 250 |
| Music (Lyria clip) | 3 |
| Checks (all) | about 10 |
| **Total, first pass** | **about 360** |

Retries add roughly 10-30%. Wall time is about 5-8 minutes with clips generated in parallel. The spike itself cost about Rs 2,500 across 12 iterations; that is the price of learning the rules in section 7, not the per-video cost.

## 11. Legal (decision pending with the user)

- Fetch logged-out only; prefer YouTube URL to Gemini (no download); delete source files after the breakdown.
- Never copy the music, a real person's face, logos, or a verbatim script. Copy structure, poses and timing only.
- Label the output as AI-generated (India IT Amendment Rules 2026, in force 2026-02-20; YouTube and Meta disclosure rules) and remind the user to tick the AI label when posting.
- Get a short Indian lawyer's opinion before selling. Engine A (editing the reference footage itself) stays off until then.

## 12. Known limits

- Remake clips are 720p (Omni and Veo output); the references are often 1080p.
- The occluder is less real than a filmed one until plates exist.
- Veo blocks some faces (image-triggered); the Omni fallback covers it.
- Gemini's own timings run about 1s early; always override them with measured times.
- TikTok needs a non-India fetcher or an upload.

## 13. Phasing

1. **Breakdown:** `fetch_video`, `watch_video`, `find_cuts`, `find_hidden_cuts`, `sound_timeline`, `describe_shots`, `check_short_shots`, `break_down_video`; replace `analyze_video`'s internals. Ships value alone: the user gets a full breakdown of any reel.
2. **Checks:** the section-8 checks as reusable tools, built on the `tvcChecks` helpers.
3. **Remake v1:** casting, `plan_remake`, `make_remake`, Veo first+last in the gateway, the `occluder_edge_reveal` / hard-cut / near-still recipes, `find_occluder`, and the compositor in ai-service.
4. **Plates and more recipes:** filmed fan/door/hand plates; split-screen and other recipes.

## 14. Testing

- Replay real runs as fixtures: the fan reel, the Sony ad, the Facebook reaction and the LinkedIn poster, with the breakdowns and check results from the spike as expected values.
- Every rule in section 7 gets a regression test against the failure that produced it (two remotes, empty-hand action, slant, on/off fan, darkening flicker, PASS on empty data).
- Real-ffmpeg tests for the compositor and the frame-exact trims, following `assembleClips.realffmpeg.test.ts`.

## 15. Open decisions

1. Legal: fetching from social platforms at all, and whether engine A is ever allowed.
2. Plates: shoot our own fan footage, or license a set.
3. Whether v1 includes the Facebook-style split-screen recipe.
