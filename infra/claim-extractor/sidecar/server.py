"""HTTP sidecar exposing the ClaimExtractor model over Ratel's extractor contract.

Ratel's `HttpIntentExtractor` always speaks one contract, regardless of where the
model runs (Apple-Silicon sidecar, Docker+GPU box, or a remote/cloud endpoint):

    POST /v1/extract
      { "model"?: str,
        "messages": [{ "role": "user"|"assistant", "content": str }, ...],
        "service_description"?: object }
    -> { "claims":  [{ "subtype": str, "content": str, "evidences"?: [str] }, ...],
         "intents": [{ "content": str, "evidences"?: [str] }, ...] }

Backends (set CLAIM_EXTRACTOR_BACKEND):
  - mock          deterministic, no model — verify Ratel<->sidecar wiring anywhere
  - transformers  HuggingFace transformers (Apple Silicon: device=mps; CPU fallback)
  - vllm          vLLM (Linux + CUDA GPU; used by the Docker image)
  - auto          mock if MOCK=1, else transformers

The real backends load the model through the `orbitals` package (the model's
official inference library). The exact orbitals call may differ by version — the
`_extract_with_orbitals` helper is the single place to adjust if so.
"""

from __future__ import annotations

import sys
import threading
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI
from pydantic import BaseModel

# Import the shared settings loader whether the server is started from this
# directory (uvicorn server:app) or imported from elsewhere (tests).
sys.path.insert(0, str(Path(__file__).parent))
from settings import limit_messages, load_settings  # noqa: E402

# Resolved once at startup: defaults < settings.json < environment (see settings.py).
SETTINGS = load_settings()
MODEL_ID = SETTINGS["model"]
BACKEND = str(SETTINGS["backend"]).lower()
MOCK = bool(SETTINGS["mock"]) or BACKEND == "mock"
MAX_MESSAGES = int(SETTINGS["maxMessages"])


class Message(BaseModel):
    role: str
    content: str


class ExtractRequest(BaseModel):
    messages: list[Message]
    model: Optional[str] = None
    service_description: Optional[Any] = None


app = FastAPI(title="Ratel ClaimExtractor sidecar")
_extractor: Any = None
# Serializes inference: MPS (Apple GPU) aborts the process with a Metal
# command-buffer assertion if two model calls touch the GPU concurrently.
_extract_lock = threading.Lock()


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "model": MODEL_ID,
        "backend": "mock" if MOCK else BACKEND,
        "intentsOnly": bool(SETTINGS["intentsOnly"]),
        "maxTokens": int(SETTINGS["maxTokens"]),
        "maxMessages": MAX_MESSAGES,
        "device": SETTINGS["device"],
    }


@app.post("/v1/extract")
def extract(req: ExtractRequest) -> dict[str, Any]:
    # Send only the last N messages to the model (settings.maxMessages). Long
    # transcripts are the main driver of MPS latency/timeouts, and recent turns
    # carry the live intent; 0 disables the cap.
    messages = limit_messages(req.messages, MAX_MESSAGES)
    if MOCK:
        return _extract_mock(messages)
    try:
        # One inference at a time — see _extract_lock (MPS is not concurrency-safe).
        with _extract_lock:
            return _normalize(_extract_with_orbitals(messages, req.service_description))
    except Exception as e:  # surface the cause; this is a local dev sidecar
        import logging

        logging.exception("extraction failed")
        from fastapi import HTTPException

        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}") from e


# orbitals backends: "hf" (transformers, incl. Apple Silicon MPS) or "vllm" (CUDA GPU).
def _orbitals_backend() -> str:
    if BACKEND == "vllm":
        return "vllm"
    if BACKEND in {"hf", "transformers", "mlx", "mps"}:
        return "hf"
    try:
        import torch  # type: ignore

        if torch.cuda.is_available():
            return "vllm"
    except Exception:
        pass
    return "hf"


def _get_extractor() -> Any:
    global _extractor
    if _extractor is None:
        # Official inference package for this model:
        #   pip install "orbitals[claim-extractor-hf]"    # Apple Silicon / CPU (backend hf)
        #   pip install "orbitals[claim-extractor-vllm]"  # CUDA GPU (backend vllm)
        # ClaimExtractor is exported from the submodule, not the namespace root.
        from orbitals.claim_extractor import ClaimExtractor  # type: ignore

        # API (orbitals): ClaimExtractor(backend, model) then .extract(conversation, ...).
        backend = _orbitals_backend()
        extra: dict[str, Any] = {}
        if backend == "hf":
            # Greedy decoding → stable, repeatable extractions (no reworded dupes).
            extra["do_sample"] = False
            # Cap generation: extraction output is small (a short JSON), and the
            # orbitals default of 20k new tokens is the main cause of slow MPS/CPU
            # inference + timeouts. Raise settings.maxTokens only if outputs get
            # truncated.
            extra["max_new_tokens"] = int(SETTINGS["maxTokens"])
            # Optional device pin: settings.device="cpu" avoids MPS instability
            # (slower but crash-free); "mps" forces the Apple GPU. None lets
            # transformers pick (MPS when available).
            if SETTINGS["device"]:
                extra["device"] = SETTINGS["device"]
        # Skip claim extraction for ~2x faster intents-only runs (intents are what
        # the UI keys off). Toggle with settings.intentsOnly.
        if SETTINGS["intentsOnly"]:
            extra["intents_only"] = True
        _extractor = ClaimExtractor(backend=backend, model=MODEL_ID, **extra)
    return _extractor


def _extract_with_orbitals(messages: list[Message], service_description: Any = None) -> Any:
    extractor = _get_extractor()
    conversation = [{"role": m.role, "content": m.content} for m in messages]
    return extractor.extract(conversation, ai_service_description=service_description)


# orbitals subtypes are Title Case; map to the wire contract's lowercase_underscore form.
_SUBTYPE_MAP = {
    "factoid": "factoid",
    "capability": "capability",
    "user assertion": "user_assertion",
    "unverifiable": "unverifiable",
}


def _normalize(result: Any) -> dict[str, Any]:
    """Coerce an orbitals ClaimExtractorOutput into the wire contract."""
    extractions = getattr(result, "extractions", result)
    claims = []
    for c in _attr(extractions, "claims") or []:
        raw = _attr(c, "subtype")
        subtype = _SUBTYPE_MAP.get(str(getattr(raw, "value", raw)).strip().lower())
        content = _attr(c, "content")
        if subtype and content:
            claims.append({"subtype": subtype, "content": str(content)})
    intents = []
    for i in _attr(extractions, "intents") or []:
        content = _attr(i, "content")
        if content:
            intents.append({"content": str(content)})
    return {"claims": claims, "intents": intents}


def _attr(obj: Any, name: str) -> Any:
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


def _extract_mock(messages: list[Message]) -> dict[str, Any]:
    """Deterministic stand-in: one intent per user turn, plus a sample claim.
    Lets you validate the whole pipeline before downloading a multi-GB model."""
    intents = [
        {"content": m.content.strip()}
        for m in messages
        if m.role == "user" and m.content.strip()
    ]
    claims = []
    if intents:
        claims.append(
            {"subtype": "user_assertion", "content": f"User is working on: {intents[0]['content']}"}
        )
    return {"claims": claims, "intents": intents}
