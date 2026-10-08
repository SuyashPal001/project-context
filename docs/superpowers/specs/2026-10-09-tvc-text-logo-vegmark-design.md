# TVC Part 2.2: Animated Text, Logo and Veg Mark (Design)

Status: draft for review. This is scopes B and C of the text overlay. Scope A, the legal disclaimer, shipped in b150c893.
User choices (2026-10-09):
- The logo appears on the packshot only.
- Animation is a small fixed set of moves.
- The veg mark goes on the packshot, for food and drink only.
Branch: `text-overlay-animated`, from origin/main b150c893.

## 1. Goal

Headlines, prices and taglines move like a real TVC super. They pop, slide or stamp in on their shot, using a fixed set of moves done in code. Every ad gets the same polish, and nothing is generated into pixels. The packshot carries the brand logo and, for food and drink, the veg or non-veg mark. Both are composited in code, sized and placed by rules.

## 2. What exists today

| Piece | Today | Change |
|---|---|---|
| Shot text and tagline | `overlay_text` with static ASS (DejaVu Sans, white with an outline), sizes small/medium/large, plus the legal style from 2.1 | Gains `motion`. The default `none` is byte-identical |
| Price or offer | No support. Director writes it as shot text | A `price` style: a bigger number, an optional struck-through MRP, and the `stamp` motion |
| Logo | None. `packshot.kind: 'logo_over_scene'` exists, but there is no logo file anywhere in the plan (the tenant `logoFileId` is the app's own white-label logo, not the advertiser's) | `brief.logoFileId`, uploaded by the user in chat, composited on the packshot |
| Veg mark | The plan warns "cannot be added yet" | Drawn in code (a square with a filled dot, FSSAI colours) on the food or drink packshot |

## 3. Design

### M1: motion presets in `overlay_text` (ASS tags only)
- Overlay input gains `motion?: 'none' | 'pop' | 'slide_up' | 'fade' | 'stamp'`. The default is `none` (today's output).
- Each preset is a fixed set of ASS override tags written at the start of the line. No user text reaches a tag; only numbers derived from the frame do.
  - **pop:** scale 80% → 100% over 180 ms (`\fscx80\fscy80\t(0,180,\fscx100\fscy100)`), with a 120 ms alpha fade-in.
  - **slide_up:** `\move` from 4% of the frame height below the final position to the position, over 220 ms, with an alpha fade-in. Uses `\pos`/`\move` from the real frame size.
  - **fade:** `\fad(150,150)`.
  - **stamp:** 130% → 100% over 140 ms with a slight overshoot (`\t(0,100,…115)\t(100,140,…100)`) and a 1-frame flash. Meant for prices.
- Every preset fades out over the last 120 ms so text never pops off. The legal style ignores `motion`: disclaimers stay static, for readability and the ASCI hold.
- A shot shorter than 0.6 s gets `fade` whatever was asked, since a move needs time to read. This is a code rule.

### M2: the `price` style
- Overlay input gains `price?: { amount: string; mrp?: string; note?: string }`. When it is set, `text` is ignored for that overlay.
- **Layout:**
  - the amount is large (`large` × 1.2), e.g. "₹499";
  - when there is an MRP, it is shown smaller, to the left, struck through (ASS `\s1`), e.g. "₹699";
  - the note, e.g. "Launch offer", is small and sits under the amount.
- **Motion:** `stamp` by default.
- **Validation:**
  - `amount` and `mrp` must look like money (`₹`, `Rs` or a currency symbol, digits, optional `,` and `.`). Otherwise `PRICE_INVALID`.
  - When there is an MRP, it must be higher than the amount, otherwise `PRICE_MRP_NOT_HIGHER`. This is ASCI's comparative pricing, so an offer claim also needs a disclaimer; the plan reminds about this but does not invent one.

### M3: the logo on the packshot
- **Input:**
  - `brief.logoFileId?: string`. The user uploads it in chat, and Olmo asks for the logo once when it plans a TVC.
  - The plan checks it is an image, the same way as the product photo. It must not be the product photo itself (`LOGO_IS_PRODUCT_PHOTO`).
- **`composite_end_card`:** gains `logoFileId?`. The logo is placed on the card:
  - in the top band, centred;
  - scaled so its height is 9% of the frame's shorter side, and its width is at most 40% of the frame width;
  - with a safe margin of at least 5%.
- **Transparency:**
  - A PNG with transparency is laid as it is.
  - A logo with a solid background (JPG, or a PNG with no transparency) is laid on a rounded white plate with 8% padding, so it never looks pasted on. No background removal; that would be a generation step.
- **Placement:**
  - The logo appears on the packshot only, as the user chose.
  - Face avoidance from Part A applies: when a face is in the top band, the logo moves to a top corner, never over the face.
- **Without `logoFileId`:** today's card, unchanged and pinned.

### M4: the veg or non-veg mark
- **`brief.vegMark?: 'veg' | 'non_veg'`.**
  - For category food or beverage the plan asks Director to set it. A missing mark is a warning, not an error, because it is practice, not an ASCI rule.
  - For other categories it is ignored.
- **Drawn in code as a small vector-like PNG**, made once with ffmpeg's `drawbox` and `geq` (or a stored asset):
  - veg: green square outline (#008000) with a filled green circle;
  - non-veg: brown (#8B4513) with a filled brown triangle, the 2021 FSSAI non-veg symbol;
  - size: 5% of the shorter side;
  - a white background square, so it reads on any card.
- **Placement:** the packshot only, in the corner opposite the logo (bottom-right by default). It stays clear of the legal band: if a disclaimer is on screen, the mark moves above the disclaimer box.
- **The step:** composited in `composite_end_card`, the same pass as the logo, so there is no extra paid step and no extra ffmpeg pass.

### M5: plan and skill text
- **Shot text** gains `motion?` (default `pop` for headlines; `none` on legacy plans), plus an optional `price` per shot.
- **The finish slice** passes `motion`, `price`, `logoFileId` and `vegMark` to the right tools.
- **Skill text, append only:**
  - `tvc-ad.md`: Olmo asks for the brand logo when it plans a TVC, and for veg or non-veg on food and drink, in plain words.
  - `director.md`: use the slice's motion and price exactly; pass logoFileId and vegMark to composite_end_card.
- **The plan's veg warning** changes from "cannot be added yet" to "set brief.vegMark (veg or non_veg) for food and drink".

## 4. Edge cases

| # | Case | Decision |
|---|---|---|
| X1 | A logo that is very wide (a wordmark) or very tall | Contain inside the box: 9% of the shorter side tall, at most 40% of the width, with the aspect ratio kept. |
| X2 | A logo the same colour as the card background | The white plate is used whenever the logo has no transparency. A transparent logo on a light card gets a soft dark shadow. |
| X3 | An SVG logo | Not supported for now: `LOGO_NOT_RASTER: upload the logo as PNG or JPG`. |
| X4 | A huge logo file | Uses the existing download size cap; the logo is resized before compositing. |
| X5 | The logo uploaded mid-flow, after the end card is made | Re-running composite_end_card is cheap (about 1 credit). The plan records `logoFileId`, and the finish slice is re-read. |
| X6 | A price text in Hindi numerals (₹४९९) | Allowed. The money check accepts Devanagari digits, and the font covers them (Noto, from 2.1). |
| X7 | A price on a 0.6 s flash cut | It falls back to `fade` (M1), and the price must still be on screen ≥ 1.2 s. Otherwise the plan refuses with `PRICE_TOO_SHORT`, because a price is a claim. |
| X8 | Motion during a disclaimer | Allowed for the other text. The disclaimer itself never moves (M1). |
| X9 | 9:16 vs 16:9 | Every size and offset comes from the real frame (the shorter side), as in 2.1. |
| X10 | Talking-head, UGC or animated callers of overlay_text and composite_end_card | No new inputs means byte-identical output (pinned). |
| X11 | Escaping (`{}`, `\`) in price or headline text | Uses the shared `escapeAssText`, the same as legal. |
| X12 | An existing ad re-rendered with an old plan | The old plan has no motion, so `none`, and no logo or veg mark. The output is unchanged. |

## 5. Error handling
- New plain reasons:
  - `PRICE_INVALID`, `PRICE_MRP_NOT_HIGHER`, `PRICE_TOO_SHORT`
  - `LOGO_IS_PRODUCT_PHOTO`, `LOGO_NOT_IMAGE`, `LOGO_NOT_RASTER`
- The checks run before any charge. The paid tools keep charge-first and refund on every failure.

## 6. Testing
- **Unit:** the ASS tags each preset produces, and that no user text reaches a tag; price layout and validation; logo box maths (wide, tall, square) for 16:9 and 9:16; the veg-mark size and corner; the legacy pins for overlay_text and composite_end_card.
- **Real ffmpeg (tagged, run on the VM):**
  - render a `pop` headline and a `stamp` price, and check a mid-animation frame differs from the final frame;
  - render a logo at 1920×1080 and 1080×1920, and measure its height;
  - render the veg mark, and check its green pixels sit in the right corner.

## 7. Not in this piece
- Background removal for logos (a generation step; maybe later).
- Custom brand fonts (Noto stays the font for now).
- A logo bug throughout the ad (the user chose packshot only).
- Word-by-word kinetic text.
