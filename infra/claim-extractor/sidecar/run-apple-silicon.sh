#!/usr/bin/env bash
# Run the ClaimExtractor sidecar locally on Apple Silicon (transformers + MPS).
#
# Docker on macOS cannot pass through the Apple GPU, so the Mac path is this
# native sidecar (not the Docker image). Recommend the 2B variant for latency.
#
# All tunables live in settings.json (model, backend, device, intentsOnly,
# maxTokens, maxMessages, port). Edit it once; this script reads it directly.
# Any CLAIM_EXTRACTOR_* / PORT env var still overrides the file for one run.
#
# Usage:
#   ./run-apple-silicon.sh            # real model (downloads on first run)
#   CLAIM_EXTRACTOR_MOCK=1 ./run-apple-silicon.sh   # mock, no model — wiring check
set -euo pipefail
cd "$(dirname "$0")"

# Let PyTorch fall back to CPU for any op MPS doesn't implement yet.
export PYTORCH_ENABLE_MPS_FALLBACK="${PYTORCH_ENABLE_MPS_FALLBACK:-1}"

# orbitals requires Python >=3.10; the macOS system python3 is often older.
# Pick the newest available >=3.10 interpreter (override with PYTHON=...).
if [ -z "${PYTHON:-}" ]; then
  for cand in python3.12 python3.13 python3.11 python3.10 python3; do
    if command -v "$cand" >/dev/null 2>&1 &&
      "$cand" -c 'import sys; sys.exit(0 if sys.version_info[:2] >= (3, 10) else 1)'; then
      PYTHON="$cand"
      break
    fi
  done
fi
if [ -z "${PYTHON:-}" ]; then
  echo "Need Python >=3.10 (orbitals requires it). Try: brew install python@3.12" >&2
  exit 1
fi
echo "Using $("$PYTHON" --version) ($PYTHON)"

# Load settings.json into the environment (env vars already set still win).
# settings.py is stdlib-only, so the system interpreter can read it pre-venv.
eval "$("$PYTHON" settings.py --exports)"
PORT="${PORT:-8723}"

if [ ! -d ".venv" ]; then
  "$PYTHON" -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt
if [ "${CLAIM_EXTRACTOR_MOCK:-}" != "1" ]; then
  # claim-extractor-hf pulls transformers + accelerate (→ torch) for the hf backend.
  pip install "orbitals[claim-extractor-hf]"
fi

echo "ClaimExtractor sidecar on http://127.0.0.1:${PORT}"
echo "  backend=${CLAIM_EXTRACTOR_BACKEND:-?} model=${CLAIM_EXTRACTOR_MODEL:-?} mock=${CLAIM_EXTRACTOR_MOCK:-0}"
echo "  intentsOnly=${CLAIM_EXTRACTOR_INTENTS_ONLY:-0} maxTokens=${CLAIM_EXTRACTOR_MAX_TOKENS:-?} maxMessages=${CLAIM_EXTRACTOR_MAX_MESSAGES:-0} device=${CLAIM_EXTRACTOR_DEVICE:-auto}"
echo "Point Ratel at it:  analysis.extractor = { provider: \"http\", endpoint: \"http://127.0.0.1:${PORT}\" }"
exec uvicorn server:app --host 127.0.0.1 --port "${PORT}"
