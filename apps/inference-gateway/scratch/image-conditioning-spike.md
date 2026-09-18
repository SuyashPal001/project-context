# Task 4 spike: Interactions API image-reference format

**Status: NOT LIVE-VERIFIED.** This worktree has no real `GEMINI_API_KEY` (only
`.env.example` with a placeholder) and no reachable dev database/internal API to
mint a real presigned URL for a test image. The plan's Steps 1-2 (get a presigned
URL, curl the Interactions API with it) could not be executed against live
infrastructure from this environment.

Ruling made instead, based on documented Gemini API behavior rather than a live
test:

**The Gemini API (`generativelanguage.googleapis.com`, API-key auth path — the
Omni Flash route this project uses) does not fetch arbitrary third-party HTTPS
URLs for multimodal image input.** Its documented image-input paths are (a)
inline base64 bytes in the request body, or (b) a URI returned by Gemini's own
Files API after an explicit upload to Google's servers. A presigned S3 URL is
neither — it's a third-party HTTPS URL Google has never seen. This mirrors the
already-confirmed Vertex Veo requirement (`project_video_image_conditioning_implementation_notes`
memory: "GCS-URI required, no inline base64") — both Google video paths need
the image staged on Google-controlled/Google-fetchable storage first, not a
bare foreign URL.

**Decision for Task 5: implement the staging branch.** `stageImageForOmni` is
written for real (not left as a stub) — it downloads the presigned S3 URL's
bytes and re-uploads them to Google's Files API (`POST
https://generativelanguage.googleapis.com/upload/v1beta/files`), returning the
resulting `files/{id}` URI for use in the Interactions `input` array. This is
the Gemini-API-key equivalent of Vertex's GCS staging step, not a new pattern.

**Required follow-up, not covered by this plan:** before this ships to
production, someone with a real `GEMINI_API_KEY` and dev environment access
must run the plan's original Steps 1-2 curl test to confirm this ruling was
correct, and specifically confirm the Files API upload+reference round-trip
actually works end-to-end for a video generation call (not just that a bare
presigned URL is rejected). Record that confirmation in this file or in
`project_video_image_conditioning_implementation_notes` memory. If the live
test finds bare HTTPS URLs ARE accepted after all, `stageImageForOmni` becomes
dead code that should be removed, not left in as an unused safety branch.
