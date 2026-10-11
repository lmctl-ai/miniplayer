# Local Ollama + qwen2.5 — how to use from WSL (verified 2026-09-13)

## TL;DR — the working setup

Ollama runs on the **Windows host**; from WSL you reach it at the WSL gateway address:

```bash
export OLLAMA_HOST=http://172.18.32.1:11434   # already set in this shell's env
curl -s $OLLAMA_HOST/api/version              # {"version":"0.33.3"}
```

`172.18.32.1` = the Windows host, found via `ip route show default` in WSL. The Windows Ollama
answers on that address (it listens beyond localhost; if this ever stops working, on Windows set
`OLLAMA_HOST=0.0.0.0` for the server and allow port 11434 through the Windows firewall).
`localhost:11434` from WSL does NOT reach the Windows server here — always use the gateway IP.

## Models on the Windows server (`ollama list` via API /api/tags)

- `qwen2.5:14b` (8 GB) ← **use this one**
- `llama3.2:3b`, `all-minilm:latest` (embeddings), `kimi-k2.6:cloud`

qwen2.5 tag reference (upstream): 0.5b / 1.5b / 3b / 7b (default) / 14b / 32b / 72b.
0.5b output quality is too poor for real use (tested — rambling, wrong answers); 14b is good.

## Tested commands and real output (qwen2.5:14b, 2026-09-13)

```bash
H=http://172.18.32.1:11434

# 1) one-shot generate
curl -s $H/api/generate -d '{"model":"qwen2.5:14b","prompt":"Reply with exactly one sentence: what is the capital of France?","stream":false}'
# → "The capital of France is Paris."

# 2) chat API
curl -s $H/api/chat -d '{"model":"qwen2.5:14b","messages":[{"role":"user","content":"What is 17+25? Answer with just the number."}],"stream":false}'
# → "42"

# 3) OpenAI-compatible endpoint (for SDKs / tools expecting OpenAI shape)
curl -s $H/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"qwen2.5:14b","messages":[{"role":"user","content":"Name one primary color. One word."}]}'
# → "Red"
```

All three endpoints work. Latency observed: ~15–25 s per short call (Windows-side inference).
Use `"stream":false` for scripting, or omit for streaming NDJSON.

CLI from WSL also works against the Windows server (any recent ollama client binary):

```bash
OLLAMA_HOST=http://172.18.32.1:11434 ~/.local/opt/ollama/bin/ollama list
OLLAMA_HOST=http://172.18.32.1:11434 ~/.local/opt/ollama/bin/ollama run qwen2.5:14b "your prompt"
```

## Quality evidence (daemon-classify fitness, 2026-09-14)

qwen2.5:14b is ADEQUATE as the daemon classifier. Bake-offs vs deepseek-v4-flash (strict JSON
prompts, temp 0): v1 12 samples across #128/#146 label sets → 11/12 = 11/12 (parity); v2 fuller
pass, 16 harder/ambiguous cases → qwen 14/16, deepseek 13/16, agreement 15/16 (hard-only 13/14 vs
12/14). Residual misses were label-definition ambiguities, not comprehension failures. miniplayer's
own 5-label `classify -m ollama/qwen2.5:14b` also live-verified (task-done / escalation correct).
Operator independently got 3/3 on representative daemon cases.

## miniplayer tie-in (2026-09-14)

miniplayer has an `ollama` provider (openai-compatible, OLLAMA_HOST or localhost:11434, no key) with
connectivity failover. Operator decision (landing in code): built-in default = `ollama/qwen2.5:14b`
primary with `deepseek/deepseek-flash` failover, 60s finite call timeout
(MINIPLAYER_REQUEST_TIMEOUT_MS), connectivity+timeout errors roam to failover, 401/400/500 abort.
Daemon-host config pattern:
`{"pool": ["ollama/qwen2.5:14b", "deepseek/deepseek-v4-flash"], "poolOrdered": true, ...}`.

## miniplayer tie-in (future, not wired yet)

Ollama is OpenAI-compatible, so miniplayer's openai-compatible fallback can route it:
baseURL `http://172.18.32.1:11434/v1`, model `qwen2.5:14b`, apiKey any non-empty string (Ollama
ignores it). That would add a zero-cost, no-rate-limit local model to the pool — candidate for a
`ollama` provider entry if ever wanted.

## Local WSL fallback install (kept, but not the preferred path)

A userspace Ollama 0.33.3 also lives at `~/.local/opt/ollama/` (tarball install, no sudo) with
`qwen2.5:0.5b` pulled. Start it with:
`OLLAMA_HOST=127.0.0.1:11434 ~/.local/opt/ollama/bin/ollama serve`
Note: the shell's `OLLAMA_HOST=http://172.18.32.1:11434` must be OVERRIDDEN when starting a local
server, else it tries to bind the Windows gateway address and fails with
"bind: cannot assign requested address". Prefer the Windows server + 14b for anything real.
