# GPU Inference Setup — vLLM + Qwen3-8B on GCP

_Last updated: 2026-05-29_

Adds a dedicated GPU VM running vLLM as the local inference backend for the
inference gateway. Handles two use cases:

- **Fallback** — Vertex AI unavailable → inference-gateway routes to vLLM automatically
- **Restricted data** — `X-Data-Classification: restricted` header → vLLM only (CASA/KYC never leaves bank infra)

---

## Architecture

```
Current VM (asia-south1)              GPU VM (asia-southeast1-b)
─────────────────────────             ──────────────────────────
relay (:3001)                         nginx (:8000) ← auth layer
  └─ inference-gateway (:4001)  ────────└─ vLLM (:8001) ← internal only
       ├─ VertexAdapter  → Vertex AI (primary)
       └─ OllamaAdapter  → GPU VM   (fallback / restricted)
```

> The `OllamaAdapter` name is legacy — it calls any OpenAI-compatible
> `/v1/chat/completions` endpoint, including vLLM.

---

## Model Choice — Qwen3-8B

| Reason | Detail |
|---|---|
| VRAM fit | FP16 ~16GB — fits L4 24GB cleanly |
| EOI spec | P2-E explicitly requires fallback = "smaller open-source LLM (8B)" |
| Tool calling | Solid structured JSON output |
| Hindi support | Qwen3 family supports 29+ languages including Hindi |
| Use case | Fallback + restricted data — primary load on Vertex AI |

**VRAM budget on L4 (23034 MiB total)**

```
Qwen3-8B FP16:   ~16 GB
vLLM overhead:    ~3 GB
KV cache:         ~4 GB
─────────────────────────
Total:            23 GB  ✓ fits cleanly
```

---

## Step 1 — Launch the GPU VM ✅

```
Name:         inference-gpu
Zone:         asia-southeast1-b  (Singapore — L4 stockout in asia-south1)
Machine:      g2-standard-8 (8 vCPU, 32GB RAM)
GPU:          NVIDIA L4 (23034 MiB VRAM)
Image:        pytorch-2-9-cu129-ubuntu-2204-nvidia-580
Disk:         100GB SSD
External IP:  none (temporary external IP added for install, remove after)
Network:      default VPC
Tags:         inference-server
Provisioning: on-demand
Internal IP:  10.148.0.2
```

Command:

```bash
gcloud compute instances create inference-gpu --zone=asia-southeast1-b --machine-type=g2-standard-8 --accelerator=type=nvidia-l4,count=1 --image-family=pytorch-2-9-cu129-ubuntu-2204-nvidia-580 --image-project=deeplearning-platform-release --boot-disk-size=100GB --boot-disk-type=pd-ssd --no-address --network=default --subnet=default --tags=inference-server --maintenance-policy=TERMINATE
```

> **On-demand**: Start/stop manually to control cost. Spot was ruled out —
> preemption would make the fallback path unreliable.

> **Note on image**: `debian-12` and `common-cu122-debian-11` were not found.
> Use `pytorch-2-9-cu129-ubuntu-2204-nvidia-580` from `deeplearning-platform-release`.

> **Note on zone**: `asia-south1-a/b/c` all had L4 STOCKOUT. Used `asia-southeast1-b` (Singapore).

**Image comes preloaded with:**
- NVIDIA driver 580, CUDA 12.9
- PyTorch 2.9, Python 3.10
- `nvidia-smi`, Docker, NVIDIA Container Toolkit

**Temporary external IP** (needed for pip/HuggingFace downloads — no NAT on this VPC):

```bash
# Add before install
gcloud compute instances add-access-config inference-gpu --zone=asia-southeast1-b

# Remove after install is complete (run from Cloud Shell, not the GPU VM)
gcloud compute instances delete-access-config inference-gpu --zone=asia-southeast1-b --access-config-name="external-nat"
```

---

## Step 2 — Firewall Rule ✅

Locks nginx port `8000` to **only** the inference-gateway VM.

```bash
gcloud compute firewall-rules create allow-vllm-from-gateway --direction=INGRESS --action=ALLOW --rules=tcp:8000 --source-ranges=10.190.0.2/32 --target-tags=inference-server --description="vLLM accessible only from inference-gateway VM"
```

| VM | Internal IP |
|---|---|
| inference-gateway (current VM) | 10.190.0.2 |
| inference-gpu (GPU VM) | 10.148.0.2 |

---

## Step 3 — SSH into GPU VM ✅

```bash
gcloud compute ssh inference-gpu --zone=asia-southeast1-b --tunnel-through-iap
```

---

## Step 4 — Install vLLM ✅

```bash
pip install vllm
```

Fix PATH and python alias after install:

```bash
echo 'export PATH=$PATH:$HOME/.local/bin' >> ~/.bashrc
echo 'alias python=python3' >> ~/.bashrc
source ~/.bashrc
```

> `pip` installs to `~/.local/bin` (user install) because system site-packages
> is not writable. PATH fix makes `vllm` and other scripts accessible.

---

## Step 5 — Download Qwen3-8B ✅

```bash
pip install huggingface-hub
hf download Qwen/Qwen3-8B --local-dir ~/models/Qwen3-8B
```

> `huggingface-cli` is deprecated — use `hf` instead.
> Model saved to `/home/info_fitearnmeditate/models/Qwen3-8B`

---

## Step 6 — Create Startup Script ✅

Use a wrapper script to avoid systemd quoting issues with bash -c commands:

```bash
nano /usr/local/bin/start-vllm.sh
```

Paste:

```bash
#!/bin/bash
INTERNAL_IP=$(curl -s -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/ip)
exec python3 -m vllm.entrypoints.openai.api_server --model /home/info_fitearnmeditate/models/Qwen3-8B --host "$INTERNAL_IP" --port 8001 --dtype float16 --max-model-len 8192
```

```bash
sudo chmod +x /usr/local/bin/start-vllm.sh
```

> vLLM runs on port **8001** internally. nginx fronts on **8000** with auth.

---

## Step 7 — Run as systemd Service ✅

```bash
sudo nano /etc/systemd/system/vllm.service
```

Paste:

```ini
[Unit]
Description=vLLM inference server
After=network.target

[Service]
User=info_fitearnmeditate
WorkingDirectory=/home/info_fitearnmeditate
Environment=PATH=/home/info_fitearnmeditate/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/local/bin/start-vllm.sh
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now vllm
sudo systemctl status vllm
```

Wait for `Application startup complete` in the logs:

```bash
sudo journalctl -u vllm -f
```

---

## Step 8 — Add nginx Basic Auth ✅

vLLM has no built-in auth. nginx adds a shared secret as an extra layer.

```bash
sudo apt-get install -y nginx apache2-utils

# Generate credentials (choose a strong password)
sudo htpasswd -c /etc/nginx/.htpasswd vllm
```

```bash
sudo nano /etc/nginx/sites-available/vllm
```

Paste:

```nginx
server {
    listen 8000;
    location / {
        auth_basic "restricted";
        auth_basic_user_file /etc/nginx/.htpasswd;
        proxy_pass http://10.148.0.2:8001;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/vllm /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl enable --now nginx
```

> **proxy_pass uses the internal IP** (`10.148.0.2`), not `127.0.0.1` — vLLM
> binds to the instance's internal IP, not loopback.

---

## Step 9 — Remove Temporary External IP ✅

Run from **Cloud Shell** (not the GPU VM — insufficient auth scope on the VM):

```bash
gcloud compute instances delete-access-config inference-gpu --zone=asia-southeast1-b --access-config-name="external-nat"
```

---

## Step 10 — Update Inference Gateway ✅

On the current VM (`10.190.0.2`), edit `apps/inference-gateway/.env`:

```
OLLAMA_URL=http://vllm:<password>@10.148.0.2:8000
OLLAMA_FALLBACK_MODEL=/home/info_fitearnmeditate/models/Qwen3-8B
```

> **URL encoding**: if the password contains `@`, encode it as `%40`.
> Node.js `fetch` rejects credentials embedded in URLs — the OllamaAdapter
> extracts them and sends them as a `Basic` `Authorization` header.

```bash
pm2 restart inference-gateway --update-env
```

---

## Step 11 — Verify End-to-End ✅

```bash
# Health check — all circuits should be closed
curl http://localhost:4001/health | jq .circuits

# Force restricted-data call through vLLM
curl -s -X POST http://localhost:4001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Data-Classification: restricted" \
  -d '{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"say hello in one word"}],"stream":false}' \
  | jq '.choices[0].message.content'
```

Expected: `"Hi!"` (or similar) with `model: /home/info_fitearnmeditate/models/Qwen3-8B` in the response.

---

## Security Summary

| Layer | What it does |
|---|---|
| GCP firewall (source `/32`) | Only inference-gateway VM (`10.190.0.2`) can reach port 8000 |
| No external IP on GPU VM | Unreachable from internet after install phase |
| vLLM bound to internal IP | Won't respond on external interface |
| nginx basic auth | Shared secret — rejects unauthenticated calls |
| OllamaAdapter Basic header | Credentials never in URL, extracted at runtime |

---

## Cost Management

VM is on-demand — stop when not needed:

```bash
# Stop (saves compute cost, disk billed ~$2/month)
gcloud compute instances stop inference-gpu --zone=asia-southeast1-b

# Start when needed
gcloud compute instances start inference-gpu --zone=asia-southeast1-b
```
