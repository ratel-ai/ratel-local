"""Endpoint test: the /v1/extract route applies the last-N-messages cap.

Runs against the deterministic mock backend (no model download). Stdlib unittest
+ FastAPI TestClient (httpx). Env is set before importing/reloading ``server`` so
its module-level settings pick up the test config.
"""

from __future__ import annotations

import importlib
import os
import unittest


class TestExtractEndpointMessageCap(unittest.TestCase):
    def _client(self, max_messages: str):
        os.environ["CLAIM_EXTRACTOR_MOCK"] = "1"
        os.environ["CLAIM_EXTRACTOR_MAX_MESSAGES"] = max_messages
        import server

        importlib.reload(server)
        from fastapi.testclient import TestClient

        return TestClient(server.app)

    def tearDown(self) -> None:
        os.environ.pop("CLAIM_EXTRACTOR_MOCK", None)
        os.environ.pop("CLAIM_EXTRACTOR_MAX_MESSAGES", None)

    def test_only_last_n_messages_reach_the_model(self) -> None:
        client = self._client("2")
        messages = [{"role": "user", "content": f"u{i}"} for i in range(5)]
        res = client.post("/v1/extract", json={"messages": messages})
        self.assertEqual(res.status_code, 200)
        # mock emits one intent per user message it actually sees → only the last 2.
        intents = [i["content"] for i in res.json()["intents"]]
        self.assertEqual(intents, ["u3", "u4"])

    def test_zero_means_all_messages(self) -> None:
        client = self._client("0")
        messages = [{"role": "user", "content": f"u{i}"} for i in range(5)]
        res = client.post("/v1/extract", json={"messages": messages})
        self.assertEqual(res.status_code, 200)
        intents = [i["content"] for i in res.json()["intents"]]
        self.assertEqual(intents, ["u0", "u1", "u2", "u3", "u4"])


class TestNormalizeEvidence(unittest.TestCase):
    """`_normalize` must carry the model's evidence spans into the wire contract."""

    def _server(self):
        os.environ["CLAIM_EXTRACTOR_MOCK"] = "1"
        import server

        importlib.reload(server)
        return server

    def tearDown(self) -> None:
        os.environ.pop("CLAIM_EXTRACTOR_MOCK", None)

    def test_carries_evidence_from_strings_and_objects(self) -> None:
        server = self._server()
        result = {
            "extractions": {
                "claims": [{"subtype": "factoid", "content": "c1", "evidences": ["span a"]}],
                "intents": [
                    {"content": "i1", "evidences": [{"text": "span b"}]},  # object-shaped
                    {"content": "i2"},  # none → field omitted
                ],
            }
        }
        out = server._normalize(result)
        self.assertEqual(out["claims"][0]["evidences"], ["span a"])
        self.assertEqual(out["intents"][0]["evidences"], ["span b"])
        self.assertNotIn("evidences", out["intents"][1])


if __name__ == "__main__":
    unittest.main()
