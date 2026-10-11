#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MINIPLAYER="$REPO_DIR/bin/miniplayer.js"

export OLLAMA_HOST="${OLLAMA_HOST:-http://127.0.0.1:11434}"
MODEL="ollama/qwen2.5:14b"

echo "=== miniplayer manual Ollama check ==="
echo "Host:  $OLLAMA_HOST"
echo "Model: $MODEL"
echo

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

SYS_FILE="$TMP_DIR/system.txt"
printf "You are a concise assistant. Respond in fewer than 10 words.\n" > "$SYS_FILE"

# Step 1: miniplayer run
echo "--- Step 1: run ---"
CMD1=(node "$MINIPLAYER" run -m "$MODEL" "Say pong")
echo "Command: ${CMD1[*]}"
OUT1="$("${CMD1[@]}")"
EXIT1=$?
echo "Output:"
echo "$OUT1"
if [ $EXIT1 -eq 0 ] && [ -n "${OUT1//[[:space:]]/}" ]; then
  echo "[PASS] Step 1: run succeeded"
else
  echo "[FAIL] Step 1: run failed (exit=$EXIT1)"
  exit 1
fi
echo

# Step 2: miniplayer classify
echo "--- Step 2: classify ---"
SAMPLE_TEXT="The assigned fix is complete and all tests pass; ready for the next issue."
echo "Input:   $SAMPLE_TEXT"
echo "Command: printf '%s' \"$SAMPLE_TEXT\" | node \"$MINIPLAYER\" classify -m \"$MODEL\""
OUT2="$(printf "%s" "$SAMPLE_TEXT" | node "$MINIPLAYER" classify -m "$MODEL")"
EXIT2=$?
echo "Output:"
echo "$OUT2"
if [ $EXIT2 -eq 0 ] && [[ "$OUT2" =~ \"label\" ]]; then
  echo "[PASS] Step 2: classify succeeded"
else
  echo "[FAIL] Step 2: classify failed (exit=$EXIT2)"
  exit 1
fi
echo

# Step 3: miniplayer run with --system-file
echo "--- Step 3: run with --system-file ---"
CMD3=(node "$MINIPLAYER" run -m "$MODEL" --system-file "$SYS_FILE" "Summarize: all deployment checks green")
echo "Command: ${CMD3[*]}"
OUT3="$("${CMD3[@]}")"
EXIT3=$?
echo "Output:"
echo "$OUT3"
if [ $EXIT3 -eq 0 ] && [ -n "${OUT3//[[:space:]]/}" ]; then
  echo "[PASS] Step 3: run with --system-file succeeded"
else
  echo "[FAIL] Step 3: run with --system-file failed (exit=$EXIT3)"
  exit 1
fi
echo

echo "=== All Ollama manual checks passed ==="
exit 0
