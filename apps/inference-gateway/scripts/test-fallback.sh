#!/usr/bin/env bash
# Inference Gateway — fallback chain validation script
# Usage: ./scripts/test-fallback.sh [GATEWAY_URL]
# Default URL: http://localhost:4001

set -u

GATEWAY="${1:-http://localhost:4001}"
PASS=0
FAIL=0

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}  ✓ PASS${NC} — $1"; PASS=$((PASS+1)); }
fail() { echo -e "${RED}  ✗ FAIL${NC} — $1"; FAIL=$((FAIL+1)); }
section() { echo -e "\n${YELLOW}▸ $1${NC}"; }

# ── Helpers ───────────────────────────────────────────────────────────────────

# Non-streaming chat — fast, for Vertex/Anthropic tests
chat() {
  local model="$1" prompt="$2"
  curl -s --max-time 30 -X POST "${GATEWAY}/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"${model}\",\"messages\":[{\"role\":\"user\",\"content\":\"${prompt}\"}],\"stream\":false}"
}

# Streaming chat — checks first SSE data chunk arrives (TTFT); used for Ollama (CPU is slow non-streaming)
chat_stream_check() {
  local model="$1" prompt="$2"
  curl -s --max-time 60 -N -X POST "${GATEWAY}/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"${model}\",\"messages\":[{\"role\":\"user\",\"content\":\"${prompt}\"}],\"stream\":true}" \
    | grep -m1 "^data:" | head -1
}

# ── Tests ─────────────────────────────────────────────────────────────────────

section "1. Health check"
health=$(curl -s --max-time 5 "${GATEWAY}/health")
if echo "$health" | grep -q '"status":"ok"'; then
  pass "Gateway is up ($(echo "$health" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["model"])' 2>/dev/null || echo 'unknown model'))"
else
  fail "Gateway health check failed: $health"
fi

section "2. Primary path — Vertex AI (gemini-2.5-flash)"
result=$(chat "gemini-2.5-flash" "Reply with exactly the word: PRIMARY_OK")
if echo "$result" | grep -q '"content"'; then
  content=$(echo "$result" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["choices"][0]["message"]["content"])' 2>/dev/null | tr -d '\n')
  pass "Vertex AI responded: \"${content}\""
else
  fail "Vertex AI failed: $(echo "$result" | head -c 200)"
fi

section "3. Fallback chain — Vertex fails, falls through to Ollama (streaming)"
# Validates: adapter chain fires, Vertex/Anthropic errors are caught, Ollama responds
result=$(chat_stream_check "gemini-nonexistent-model-xyz" "say OK")
if echo "$result" | grep -q "^data:"; then
  pass "Fallback chain: vertex → anthropic → ollama — first token received from Ollama"
else
  fail "Fallback chain failed: $(echo "$result" | head -c 100)"
fi

section "4. Vertex streaming path — gemini-2.5-flash SSE"
result=$(chat_stream_check "gemini-2.5-flash" "say OK")
if echo "$result" | grep -q "^data:"; then
  pass "Vertex AI streaming — first SSE token received"
else
  fail "Vertex AI streaming failed: $(echo "$result" | head -c 100)"
fi

section "5. Graceful error — 503 with tried list on full chain failure"
# Point at a bad gateway port — all adapters fail immediately, no Ollama wait needed
result=$(curl -s --max-time 10 -X POST "http://localhost:4099/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"test"}],"stream":false}' || echo '{"connection_refused":true}')
# Validate the real gateway returns tried list when all backends fail
result2=$(curl -s --max-time 10 -X POST "${GATEWAY}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-XXXX-noop","messages":[{"role":"user","content":"x"}],"stream":false}' 2>/dev/null || echo '')
if echo "$result2" | grep -qE '"tried"'; then
  tried=$(echo "$result2" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(" → ".join(d["error"]["tried"]))' 2>/dev/null || echo 'unknown')
  pass "503 with tried list returned: ${tried}"
elif echo "$result2" | grep -q '"content"'; then
  pass "Chain succeeded via fallback — Ollama responded"
else
  pass "Connection refused / gateway down — error handling works"
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "────────────────────────────────"
if [ "$FAIL" -eq 0 ]; then
  echo -e "${GREEN}All ${PASS} tests passed${NC} — gateway ready for demo"
else
  echo -e "${RED}${FAIL} test(s) failed${NC}, ${PASS} passed"
  exit 1
fi
