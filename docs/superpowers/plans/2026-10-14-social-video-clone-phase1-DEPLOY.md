# Phase 1 deploy (VM)

Confirm with the user before restarting any PM2 process.

1. Pull and build: `git pull` on main, `pnpm install --frozen-lockfile`, then the usual workspace build for the orchestrator and gateway.
2. System tools: `ffmpeg -version` and `ffprobe -version` must work (the ai-service and the orchestrator both call them). If missing: `sudo apt install ffmpeg`.
3. Gateway: deploy as usual (PM2 `inference-gateway` restart). It now accepts video input and never falls back to Ollama for a video request.
4. yt-dlp on the VM: `python3 -m pip install --user -U yt-dlp` and add a weekly cron `python3 -m pip install --user -U yt-dlp`. Check: `yt-dlp --version`. Logged-out only: never add cookies or accounts.
5. ai-service:
   First run `pm2 ls`. If an `ai-service` process already exists, keep its name and update its command/env; do not start a second process on port 3004.
   cd apps/ai-service && python3 -m venv .venv && . .venv/bin/activate
   pip install --index-url https://download.pytorch.org/whl/cpu "torch>=2.6" && pip install -r requirements.txt   # needs Python >= 3.10; tested on 3.13 with torch 2.11, numpy 2.5, opencv-headless 5, librosa 1.0
   Env: INTERNAL_SERVICE_KEY (same value as Secrets Manager project-context/dev/internal-service-key; without it every request is refused), MEDIA_DIR=$HOME/.project-context/media/inbound
   MEDIA_DIR must stay the folder the orchestrator downloads into (`MEDIA_DIR` in apps/agent-orchestrator/src/types.ts, `~/.project-context/media/inbound`, same user). If the two differ, every /media/* call is rejected as outside MEDIA_DIR.
   pm2 start "/path/to/apps/ai-service/.venv/bin/uvicorn main:app --host 127.0.0.1 --port 3004" --name ai-service
   Check: curl -s localhost:3004/health
6. Orchestrator env: AI_SERVICE_URL=http://127.0.0.1:3004.
   Leave SHOT_CHECK_MODEL unset (default `openrouter/openai/gpt-6-sol`). It needs an OpenRouter key; without one the short-shot check returns "unknown", which is safe.
   Confirm the VM's Vertex/Gemini project can call `gemini-3.8-flash` (the video watch model).
   Then `pm2 restart` the orchestrator (deploy.sh does NOT restart it).
7. Seed the skill text (template-video.md, new item 7) the same way as other Official skill updates.
8. Live test in chat: paste https://www.instagram.com/p/DdzH5VVgmYT/ and ask "break this down". Expect hidden cuts near 5.4 / 9.2 / 12.7s, the remote moment, and leg sides per look.
9. Test from the VM that YouTube and Instagram downloads are not blocked from the datacenter IP; if they are, note it — users then upload. TikTok is refused by design.

# Phase 2 additions

1. Orchestrator env (optional): VIDEO_WATCH_MODEL, VIDEO_CHECK_MODEL (default gemini-3.8-flash; set gemini-3.6-flash to switch back without code).
2. ai-service: restart PM2 `ai-service` (new /media/motion-peaks, /media/brightness-jumps, /media/coverage).
3. Studio: the six video scorers appear after the orchestrator restart. (The local-file breakdown is deliberately not a Studio workflow: Studio has no auth.)
4. Golden set before any prompt/model change: GOLDEN_DIR=<folder with fan_reel.mp4, sony.mp4> pnpm tsx scripts/video-golden-set.ts → must print "passed". Needs a reachable gateway and ai-service (INFERENCE_GATEWAY_URL, AI_SERVICE_URL, INTERNAL_SERVICE_KEY) and MEDIA_DIR covering GOLDEN_DIR. As of 2026-10-15 it prints "failed" (fan-reel hidden cuts flaky, leg sides low) — known, not a deploy blocker for the breakdown itself.
