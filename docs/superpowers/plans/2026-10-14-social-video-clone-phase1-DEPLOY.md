# Phase 1 deploy (VM)

1. Gateway: deploy as usual (PM2 `inference-gateway` restart).
2. yt-dlp on the VM: `python3 -m pip install --user -U yt-dlp` and add a weekly cron `python3 -m pip install --user -U yt-dlp`. Check: `yt-dlp --version`.
3. ai-service:
   cd apps/ai-service && python3 -m venv .venv && . .venv/bin/activate
   pip install --index-url https://download.pytorch.org/whl/cpu "torch>=2.6" && pip install -r requirements.txt   # needs Python >= 3.10; tested on 3.13 with torch 2.11, numpy 2.5, opencv-headless 5, librosa 1.0
   Env: INTERNAL_SERVICE_KEY (same value as Secrets Manager project-context/dev/internal-service-key), MEDIA_DIR=$HOME/.project-context/media/inbound
   pm2 start "/path/to/apps/ai-service/.venv/bin/uvicorn main:app --host 127.0.0.1 --port 3004" --name ai-service
   Check: curl -s localhost:3004/health
4. Orchestrator env: AI_SERVICE_URL=http://127.0.0.1:3004, SHOT_CHECK_MODEL=<id verified in Task 9 Step 5>; then `pm2 restart` the orchestrator (deploy.sh does NOT restart it).
5. Seed the skill text (template-video.md) the same way as other Official skill updates.
6. Live test in chat: paste https://www.instagram.com/p/DdzH5VVgmYT/ and ask "break this down". Expect hidden cuts near 5.4 / 9.2 / 12.7s, the remote moment, and leg sides per look.
7. Test from the VM that YouTube and Instagram downloads are not blocked from the datacenter IP; if they are, note it — users then upload.
