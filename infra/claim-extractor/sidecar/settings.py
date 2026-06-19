"""Single source of truth for the ClaimExtractor sidecar's runtime settings.

Resolution order (highest priority first):

  1. Environment variable (``CLAIM_EXTRACTOR_*`` / ``PORT``) — ad-hoc override
  2. ``settings.json`` next to this file (or ``$CLAIM_EXTRACTOR_SETTINGS``)
  3. Built-in :data:`DEFAULTS`

Both ``server.py`` and ``run-apple-silicon.sh`` read their configuration through
here, so the file is set once and honored everywhere. The script consumes the
``--exports`` form (``eval``-able ``export`` lines); the server imports
:func:`load_settings` directly.
"""

from __future__ import annotations

import json
import os
import shlex
from pathlib import Path
from typing import Any

# Built-in defaults. Tuned for the local Apple-Silicon path: intents-only and a
# capped output/transcript keep MPS inference fast and well under the client's
# 5-minute timeout. Override any of these in settings.json.
DEFAULTS: dict[str, Any] = {
    "port": 8723,
    "backend": "transformers",  # mock | transformers/hf | vllm | auto
    "model": "principled-intelligence/claim-extractor-4B-q-2605",
    "mock": False,
    "device": None,  # None → let transformers pick (MPS when available); "cpu"/"mps" to pin
    "intentsOnly": True,  # skip the claim pass (~2x faster); the UI only uses intents
    "maxTokens": 2048,  # max NEW tokens generated per extraction
    "maxMessages": 40,  # send only the last N messages to the model (0 = no limit)
}

# setting key -> (environment variable, value kind)
ENV_MAP: dict[str, tuple[str, str]] = {
    "port": ("PORT", "int"),
    "backend": ("CLAIM_EXTRACTOR_BACKEND", "str"),
    "model": ("CLAIM_EXTRACTOR_MODEL", "str"),
    "mock": ("CLAIM_EXTRACTOR_MOCK", "bool"),
    "device": ("CLAIM_EXTRACTOR_DEVICE", "str"),
    "intentsOnly": ("CLAIM_EXTRACTOR_INTENTS_ONLY", "bool"),
    "maxTokens": ("CLAIM_EXTRACTOR_MAX_TOKENS", "int"),
    "maxMessages": ("CLAIM_EXTRACTOR_MAX_MESSAGES", "int"),
}

_TRUE = {"1", "true", "yes", "on"}


def _kind_of(key: str) -> str:
    return ENV_MAP[key][1]


def _coerce(value: Any, kind: str) -> Any:
    if kind == "int":
        return int(value)
    if kind == "bool":
        if isinstance(value, bool):
            return value
        return str(value).strip().lower() in _TRUE
    return str(value)


def _settings_path(path: str | os.PathLike[str] | None = None) -> Path:
    if path is not None:
        return Path(path)
    env = os.environ.get("CLAIM_EXTRACTOR_SETTINGS")
    if env:
        return Path(env)
    return Path(__file__).with_name("settings.json")


def load_settings(
    path: str | os.PathLike[str] | None = None,
    environ: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Resolve settings from defaults < settings.json < environment.

    A missing or malformed settings file is non-fatal: the sidecar falls back to
    defaults (and any env overrides) rather than failing to start.
    """
    environ = os.environ if environ is None else environ
    settings = dict(DEFAULTS)

    file_path = _settings_path(path)
    try:
        raw = json.loads(file_path.read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            for key in settings:
                if key in raw and raw[key] is not None:
                    settings[key] = _coerce(raw[key], _kind_of(key))
    except FileNotFoundError:
        pass
    except (ValueError, OSError):
        # malformed JSON / unreadable file — keep defaults rather than crash
        pass

    for key, (env_name, kind) in ENV_MAP.items():
        value = environ.get(env_name)
        if value not in (None, ""):
            settings[key] = _coerce(value, kind)

    return settings


def limit_messages(messages: list[Any], max_messages: int | None) -> list[Any]:
    """Return only the last ``max_messages`` entries (0/None/negative → all)."""
    items = list(messages)
    if not max_messages or max_messages <= 0:
        return items
    return items[-max_messages:]


def shell_exports(settings: dict[str, Any]) -> str:
    """Render resolved settings as ``eval``-able ``export`` lines for the run script."""
    lines: list[str] = []
    for key, (env_name, kind) in ENV_MAP.items():
        value = settings.get(key)
        if value is None:
            continue
        if kind == "bool":
            value = "1" if value else "0"
        lines.append(f"export {env_name}={shlex.quote(str(value))}")
    return "\n".join(lines)


def _main(argv: list[str]) -> int:
    settings = load_settings()
    arg = argv[1] if len(argv) > 1 else "--exports"
    if arg == "--exports":
        print(shell_exports(settings))
    elif arg.startswith("--get="):
        print(settings.get(arg[len("--get=") :], ""))
    elif arg == "--json":
        print(json.dumps(settings, indent=2))
    else:
        print(f"usage: {argv[0]} [--exports|--get=<key>|--json]", flush=True)
        return 2
    return 0


if __name__ == "__main__":
    import sys

    raise SystemExit(_main(sys.argv))
