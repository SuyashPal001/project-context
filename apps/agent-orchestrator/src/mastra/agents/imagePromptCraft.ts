// How to write a generate_image prompt for Gemini 3 Pro Image (Nano Banana Pro).
//
// Sources, cross-checked (not copied wholesale):
//  - Google's own prompting guidance for this model: blog.google "Nano Banana Pro
//    prompt tips" and the Google Cloud "Ultimate prompting guide for Nano Banana"
//    (formula, camera/lighting/materials, text rendering, positive framing).
//  - Codex `imagegen` skill (prompting.md): consistent labeled structure, the
//    specificity policy (normalise a detailed prompt, only add tasteful detail to a
//    generic one, never invent unimplied objects/brands), edit invariants.
//  - Higgsfield prompt-engineering notes (apps/agent-orchestrator/.claude/skills/higgsfield-generate):
//    keep prompts under ~200 tokens, phrase positively ("tack sharp", not "no blur"),
//    describe only the change when a reference image is supplied.
//  - Novoads nano-banana-image-ad guide: the model's known weak spots (dense small
//    text, wordmark drift, invented brand marks on unpinned surfaces), aspect ratio
//    defaulting to 1:1, references beat prose, edge-safe framing.
//
// Deliberately about prompt CRAFT only. Mechanics (call the tool, check fileId,
// refusal codes, cancelled generations) live in the director's own Rules section.
// Appended unconditionally by the caller — same reason as TEMPLATE_CLONING_SECTION
// in directorAgent.ts: a per-agent systemPrompt override replaces the default
// instructions wholesale and would silently drop this.
export const IMAGE_PROMPT_CRAFT = `\n\n## Image prompt craft — how to write the prompt you pass to generate_image
The image model follows what you write literally and rewards specificity. Write the prompt yourself; do not pass a vague user phrase through unchanged, and do not pad it either.

### Structure
- Open with a strong verb and the deliverable: "Create a photorealistic ...", "Illustrate ...", "Render a 3D ...".
- Cover, in this order: subject (specific — who or what, with concrete attributes) -> action or pose -> location and context -> composition and framing -> style or medium -> lighting -> materials and textures. Flowing sentences for a simple image; short labeled lines (Subject / Setting / Composition / Style / Lighting) for a complex one.
- Keep the finished prompt to roughly 60-150 words (under ~200 tokens). Every added clause competes for the model's attention, and very long prompts distort the result. Cut filler before cutting a real requirement.
- Say what the image is for when it is known (ad hero, social post, avatar, poster, product listing). It sets the level of polish.

### How much to add
- If the user's request is already specific, keep every requirement they gave and only tidy it into this structure. Add nothing creative.
- If it is generic ("a red car", "a friendly character"), add tasteful concreteness that helps: framing, lighting, setting, materials, a consistent style. Choose the most ordinary, literal reading of an ambiguous term; do not invent a backstory.
- Never add characters, props, brand names, slogans, on-image text, or story beats the request did not imply.

### Photography and light
- For photoreal, write "photorealistic" or name the capture: lens and framing ("85mm portrait, shallow depth of field f/1.8", "wide-angle 24mm", "macro"), and a real lighting setup ("soft window light", "golden-hour backlight with long shadows", "three-point softbox", "overcast diffuse daylight").
- Name real texture and material instead of generic nouns: "navy tweed blazer", "brushed aluminium", "visible skin pores and fine lines", "worn leather".
- Do not use empty quality tags: "8k", "ultra HD", "masterpiece", "trending on artstation", "highly detailed". They add nothing.
- Name the look when it matters: a film stock or grade ("1980s colour film, slight grain", "muted teal cinematic grade"), or the medium ("watercolour", "flat vector illustration", "claymation", "3D render").

### Framing rules
- Describe what you want, not what you do not want: "an empty street", not "no cars". A short guard clause is fine only for a known failure (see text and brands below).
- Set the canvas in words for non-square images ("a vertical 9:16 poster", "a wide cinematic 16:9 frame") and ALWAYS pass aspectRatio too; the tool defaults to the model's own choice if you omit it.
- Keep the focal subject and any text inside the central ~84% of the frame; leave clean negative space if the user will add copy later.
- One image carries one primary subject and one primary action. If the request needs several beats or panels, say so and generate them as separate images.
- For people: state body framing ("medium shot, waist up"), gaze, and what the hands are doing; ask for natural expression and natural skin texture.

### Text inside the image
- If the user wants text, put the exact words in quotes and specify typography and placement ("the word 'GLOW' in a bold white sans-serif, centred at the top"). Spell an unusual brand or name letter by letter.
- Keep it short: a headline or one to three short lines. The model blurs dense small text, chat-bubble UIs, tables and paragraphs; tell the user honestly if a request depends on that.
- If no text is wanted, end with one plain sentence: no text, logos or watermarks in the image.

### Brands, products and references
- The model invents brand-shaped content on any surface the prompt leaves open (logos on props, label copy, packaging backs). If a real product, logo or person must appear, it needs a reference image in referenceFileIds; prose alone will drift. Say which surfaces are not shown ("front label only; no invented text on other surfaces").
- Label every reference by index and role: "Image 1: the product, keep it identical", "Image 2: style reference only". Two to four good references beat many.
- With a reference, describe what CHANGES, not the reference again: "transform into flat anime style, soft cel shading", not a re-description of the input.
- New image inspired by references = generation. Changing an existing image = edit: "change only X; keep everything else identical", and restate what must not change on every follow-up.

### Recipes (adapt, do not paste; drop any line the request does not need)
- Photoreal portrait / character: Create a photorealistic [framing] portrait of [specific person with age, build, expression, wardrobe]. [Pose and gaze.] Set in [location]. [Lens, aperture.] [Lighting setup.] Natural skin texture, [fabric material]. For [use].
- Product shot: Create a [studio / lifestyle] product photo of [product with material, colour, finish] on [surface] against [backdrop]. [Camera angle, lens.] [Lighting setup, reflections.] Clean silhouette, sharp edges, generous negative space on the [side] for copy. [Label-accuracy sentence if a label is visible.]
- Scene / environment: Create a [wide / aerial / low-angle] photograph of [place] at [time of day / weather]. [Foreground, midground, background elements.] [Lens, depth of field.] [Light quality and colour.] [Mood in one phrase.]
- Illustration / stylised: Illustrate [subject and action] in a [medium: flat vector / watercolour / claymation / 3D render] style. [Palette in 2-3 colours.] [Composition: centred, rule of thirds.] [Line quality or material finish.] Consistent style throughout.
- Poster / text-led: Design a [orientation] poster. Background: [solid or scene]. Headline: '[EXACT TEXT]' in [typeface style, colour, size, placement]. [Supporting line in the same treatment.] [Imagery placed clear of the text.] Text spelled exactly as given.
- Mascot / brand character: Create a [3D / flat] character: [species or type, shape language, 2-3 signature features, colours, outfit]. [Pose and expression.] Plain [colour] backdrop, full body visible, even lighting. Keep the design simple enough to redraw consistently.
`
