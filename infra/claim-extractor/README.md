# ClaimExtractor sidecar

Runs [`principled-intelligence/claim-extractor-4B-q-2605`](https://huggingface.co/principled-intelligence/claim-extractor-4B-q-2605)
— a Qwen3.5-4B fine-tune (Apache-2.0) that turns conversation turns into structured
**claims** and **intents** — as a small HTTP service that Ratel's intent pipeline calls.

Ratel never imports the model. It only holds an HTTP client + an endpoint URL, so
the *same* Ratel config works whether the model runs as a local sidecar, in Docker
on a GPU box, or behind a cloud endpoint. Pick a deployment, point Ratel at it.

## The contract

Ratel speaks the **orbitals claim-extractor** contract, so a local sidecar and the
hosted Principled endpoint are interchangeable — switching is just the `endpoint`
URL (and auth):

```
POST {endpoint}/orbitals/claim-extractor/extract
  { "conversation": [{ "role": "user"|"assistant", "content": str }],
    "model"?: str,
    "skip_evidences"?: bool,
    "ai_service_description"?: object }
->
  { "extractions": {
      "claims":  [{ "subtype": "factoid"|"capability"|"user_assertion"|"unverifiable",
                    "content": str, "evidences"?: [str] }],
      "intents": [{ "content": str, "evidences"?: [str] }] },
    "model": str, "usage": {…}, "time_taken": float }
```

`GET /health` returns `{ status, … }`. The legacy `POST /v1/extract` route (body
`messages`, an unwrapped `{ claims, intents }` response) is still served for older
clients. `skip_evidences`/`model` are honored by the hosted endpoint; the sidecar
serves the single model + settings it was launched with and ignores per-request
overrides.

## Deployments

### 1. Apple Silicon (local, recommended on a Mac)

Docker on macOS can't pass through the Apple GPU, so the Mac path is a **native
sidecar** using `transformers` on MPS. Prefer the **2B variant** for latency.

```bash
cd infra/claim-extractor/sidecar
./run-apple-silicon.sh                 # downloads the model on first run
# or, to verify wiring with no model download:
CLAIM_EXTRACTOR_MOCK=1 ./run-apple-silicon.sh
```

### 2. Docker + NVIDIA GPU (Linux / cloud)

```bash
docker compose -f infra/claim-extractor/docker-compose.yml up --build
```

Needs the NVIDIA Container Toolkit. The image uses the **vLLM** backend.

### 3. Remote / hosted endpoint

Run either of the above on a remote host, or point Ratel at the hosted Principled
endpoint. Only the URL and auth change — the contract is identical. Auth is either
`bearer` (a token) or `basic` (username + password):

```bash
curl https://orbitals-preview.principled.app/health \
  -H 'authorization: Basic <base64(username:password)>'
```

## Point Ratel at it

In the UI: **Intents → Settings → Extractor** (use **Test connection** to verify
the endpoint + credentials against `/health`). Or in `~/.ratel/config.json`:

```json
{
  "analysis": {
    "enabled": true,
    "extractor": {
      "provider": "http",
      "endpoint": "http://127.0.0.1:8723"
    }
  }
}
```

A local sidecar and a hosted endpoint use the **same** `http` provider — only the
URL and auth differ. A local sidecar needs no auth; a hosted endpoint adds the auth
fields — `basic` (with `username` + the password in `apiKey`) or `bearer` (token in
`apiKey`):

```json
{
  "analysis": {
    "extractor": {
      "provider": "http",
      "endpoint": "https://orbitals-preview.principled.app",
      "authScheme": "basic",
      "username": "ratel",
      "apiKey": "<password>"
    }
  }
}
```

`apiKey` is the bearer token **or** the basic-auth password; it's stored masked in
the UI (`username` is not secret). `authScheme` is optional — it defaults to `basic`
when a `username` is set, else `bearer`. (An older `"provider": "cloud"` is still
accepted and behaves identically.) With no endpoint configured, Ratel falls back to
the model-free `naive` extractor.

A long chat is split into size-bounded chunks before being sent, so it can't overflow
the model's context window (which otherwise returns a fast 500); the per-chunk claims
and intents are merged and de-duplicated. The chunk budget is the JSON size of one
request's `conversation` and defaults to a conservative value tuned for the hosted
model. Raise it for a sidecar with a larger window via the optional
`"maxRequestChars": <positive integer>` under `extractor`. Transient `5xx`/network
failures are retried with backoff; a `4xx` (and timeouts) are not.

## Mock mode

Every deployment honors `CLAIM_EXTRACTOR_MOCK=1` (or `CLAIM_EXTRACTOR_BACKEND=mock`),
which returns deterministic output (one intent per user turn) with no model. Use it
to validate the full Ratel → sidecar → Intents tab path on any machine before
pulling multi-GB weights.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `CLAIM_EXTRACTOR_BACKEND` | `auto` | `mock` \| `transformers` \| `vllm` \| `auto` |
| `CLAIM_EXTRACTOR_MODEL` | `principled-intelligence/claim-extractor-4B-q-2605` | model id (swap for the 2B variant) |
| `CLAIM_EXTRACTOR_MOCK` | `0` | `1` forces mock output |
| `CLAIM_EXTRACTOR_DEVICE` | unset | `cpu` (stable, slower) or `mps` (Apple GPU); hf backend only |
| `CLAIM_EXTRACTOR_MAX_TOKENS` | `4096` | max generated tokens (hf); lower = faster, raise only if output truncates |
| `CLAIM_EXTRACTOR_INTENTS_ONLY` | `0` | `1` skips claim extraction (~2x faster; intents only) |
| `PORT` | `8723` | sidecar port (Apple Silicon script) |

## Troubleshooting

**Sidecar aborts mid-run on Apple Silicon** with a Metal assertion like
`A command encoder is already encoding to this command buffer` (often after a
successful `200`):

This is a PyTorch **MPS (Apple GPU) bug**, not a config problem — the model falls
back to a torch implementation of linear attention whose MPS ops are unstable,
and the Metal abort is a hard `SIGABRT` Python can't catch. Mitigations, in order:

1. The sidecar already **serializes inference** (one GPU call at a time), which
   removes the most common trigger. Make sure you're not running two sidecars on
   the same model.
2. If it still crashes, **run on CPU** — stable, just slower:
   ```bash
   CLAIM_EXTRACTOR_DEVICE=cpu ./run-apple-silicon.sh
   ```
3. Or try the lighter **2B variant**, which is gentler on MPS:
   ```bash
   CLAIM_EXTRACTOR_MODEL=principled-intelligence/claim-extractor-2B-q-2605 ./run-apple-silicon.sh
   ```

`NVML initialization failed` and the `flash-linear-attention` / `causal-conv1d`
notices are harmless on a Mac (no NVIDIA GPU; the fast CUDA kernels just aren't
used).

**Extraction is slow / Ratel reports "intent extractor timed out":**
The model is working (the sidecar logs show weight loading + generation), just
slow on MPS/CPU. The sidecar already caps generation at
`CLAIM_EXTRACTOR_MAX_TOKENS=4096`; lower it further (e.g. `2048`) and/or set
`CLAIM_EXTRACTOR_INTENTS_ONLY=1` for ~2x faster runs. The lighter **2B variant**
helps most. Ratel itself no longer blocks on the run — the Intents tab shows a
live "Analyzing…" indicator while it finishes in the background.

> The real backends load the model through the `orbitals` package. If its API
> differs from the version pinned here, adjust `_extract_with_orbitals` in
> `sidecar/server.py` — that's the only coupling point.
