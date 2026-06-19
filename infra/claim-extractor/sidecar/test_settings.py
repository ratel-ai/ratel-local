"""Tests for the sidecar settings loader and the last-N-messages cap.

Stdlib-only (``python -m unittest``); also discovered by pytest. No model deps.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from settings import DEFAULTS, limit_messages, load_settings, shell_exports


def _write(tmp: Path, data: object) -> Path:
    path = tmp / "settings.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


class TestLoadSettings(unittest.TestCase):
    def test_defaults_when_no_file_and_no_env(self) -> None:
        settings = load_settings(path="/nonexistent/settings.json", environ={})
        self.assertEqual(settings, DEFAULTS)

    def test_json_overrides_defaults(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            path = _write(Path(d), {"maxTokens": 999, "intentsOnly": False, "maxMessages": 5})
            settings = load_settings(path=path, environ={})
        self.assertEqual(settings["maxTokens"], 999)
        self.assertEqual(settings["intentsOnly"], False)
        self.assertEqual(settings["maxMessages"], 5)
        # untouched keys keep their defaults
        self.assertEqual(settings["model"], DEFAULTS["model"])

    def test_env_overrides_json(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            path = _write(Path(d), {"maxTokens": 999})
            settings = load_settings(
                path=path,
                environ={"CLAIM_EXTRACTOR_MAX_TOKENS": "16", "CLAIM_EXTRACTOR_MAX_MESSAGES": "3"},
            )
        self.assertEqual(settings["maxTokens"], 16)
        self.assertEqual(settings["maxMessages"], 3)

    def test_bool_coercion_from_env_and_json(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            path = _write(Path(d), {"intentsOnly": False})
            from_json = load_settings(path=path, environ={})
            from_env = load_settings(path=path, environ={"CLAIM_EXTRACTOR_INTENTS_ONLY": "1"})
        self.assertIs(from_json["intentsOnly"], False)
        self.assertIs(from_env["intentsOnly"], True)

    def test_null_device_falls_back_to_default(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            path = _write(Path(d), {"device": None})
            settings = load_settings(path=path, environ={})
        self.assertIsNone(settings["device"])

    def test_malformed_json_falls_back_to_defaults(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "settings.json"
            path.write_text("{ this is not json", encoding="utf-8")
            settings = load_settings(path=path, environ={})
        self.assertEqual(settings, DEFAULTS)

    def test_empty_env_value_does_not_override(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            path = _write(Path(d), {"maxTokens": 999})
            settings = load_settings(path=path, environ={"CLAIM_EXTRACTOR_MAX_TOKENS": ""})
        self.assertEqual(settings["maxTokens"], 999)


class TestLimitMessages(unittest.TestCase):
    def setUp(self) -> None:
        self.msgs = [{"role": "user", "content": f"m{i}"} for i in range(5)]

    def test_returns_last_n(self) -> None:
        self.assertEqual(limit_messages(self.msgs, 2), self.msgs[-2:])

    def test_zero_means_no_limit(self) -> None:
        self.assertEqual(limit_messages(self.msgs, 0), self.msgs)

    def test_none_means_no_limit(self) -> None:
        self.assertEqual(limit_messages(self.msgs, None), self.msgs)

    def test_negative_means_no_limit(self) -> None:
        self.assertEqual(limit_messages(self.msgs, -1), self.msgs)

    def test_larger_than_length_returns_all(self) -> None:
        self.assertEqual(limit_messages(self.msgs, 99), self.msgs)

    def test_does_not_mutate_input(self) -> None:
        original = list(self.msgs)
        limit_messages(self.msgs, 2)
        self.assertEqual(self.msgs, original)


class TestShellExports(unittest.TestCase):
    def test_emits_export_lines_with_bool_as_1_0(self) -> None:
        settings = load_settings(path="/nonexistent", environ={})
        out = shell_exports(settings)
        self.assertIn("export PORT=8723", out)
        self.assertIn("export CLAIM_EXTRACTOR_MAX_MESSAGES=40", out)
        self.assertIn("export CLAIM_EXTRACTOR_INTENTS_ONLY=1", out)

    def test_omits_none_device(self) -> None:
        settings = load_settings(path="/nonexistent", environ={})
        self.assertNotIn("CLAIM_EXTRACTOR_DEVICE", shell_exports(settings))


if __name__ == "__main__":
    unittest.main()
