---
name: animated-character-library
description: Generate and maintain original reusable animated-character avatar concepts for this platform. Use when creating new character concepts or approved character variants; do not add unapproved prompts to the catalog.
---

# Animated character library

Use the `imagegen` skill's built-in image generation workflow for concept portraits. Read [approved-characters.md](references/approved-characters.md) for the approved cozy set, [approved-game-characters.md](references/approved-game-characters.md) for the approved console-game set, [approved-cinematic-anime.md](references/approved-cinematic-anime.md) for the approved elegant anime set, [approved-fantasy-anime.md](references/approved-fantasy-anime.md) for the approved fantasy anime set, [approved-3d-chibi.md](references/approved-3d-chibi.md) for the approved expressive 3D human characters, [approved-storybook-anime.md](references/approved-storybook-anime.md) for the approved hand-painted everyday-life anime characters, and [approved-tvc-characters.md](references/approved-tvc-characters.md) for photoreal TVC leads. Their concept images are in `docs/design-references/`.

## New concepts

- Make each character original, with a readable silhouette, expressive face, and parts that can gesture in later video generation.
- Keep a set visually varied in subject, material, palette, and personality. A style reference guides production quality, not the copying of a recognizable character or franchise.
- Generate one standalone portrait per character. Save draft images for review in `docs/design-references/animated-avatars/`, marked as concepts.
- Only after the user approves a character, add its exact generation prompt to the approved catalog. A generated portrait alone is not an animation or a consistency sheet.
- For approved characters intended for video, create a separate identity sheet and test motion before treating them as production-ready presets.

## TVC characters

- Read the supplied TVC continuity sheets as identity references: use their profile, face, expression, pose, costume, material, and color details consistently.
- If the user asks for a character only, output one person in one image. Do not turn the continuity sheet into a collage or contact sheet.
- Aim for a natural live-action commercial photograph: realistic skin texture and facial asymmetry, believable eyes and hair, soft commercial lighting, and no beauty-filter smoothness.
- For a face correction, edit only the face and preserve the approved character's hair, wardrobe, pose, framing, and setting.
- Save generation prompts to the approved TVC catalog only after the user approves the result.
