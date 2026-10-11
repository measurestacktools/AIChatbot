"""SSE streaming tests for POST /api/chat/stream (mocked Groq, no key needed).

Protocol (mirrors PDFChat conventions):
  - token chunks:  data: {"delta": "<token>"}
  - final event:   event: done / data: {"reply": ..., "model": ...}
  - errors:        event: error / data: {"error": ..., "code": ...}

Covers: stream completion, mid-stream provider error, empty stream,
validation before streaming, missing key, and early client disconnect.

Run: pytest tests/test_stream.py
"""

import json

import pytest
from fastapi.testclient import TestClient

import app as m
from test_chat import FakeStatusError, FakeTimeoutError, TEST_KEY

client = TestClient(m.app)


@pytest.fixture(autouse=True)
def clean_state(monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.delenv("GROQ_MODEL", raising=False)
    m._rate_hits.clear()
    yield
    m._rate_hits.clear()


# ---------------------------------------------------------------------------
# Fake streaming Groq client
# ---------------------------------------------------------------------------
class _Delta:
    def __init__(self, content):
        self.content = content


class _Choice:
    def __init__(self, content):
        self.delta = _Delta(content)


class _Chunk:
    def __init__(self, content):
        self.choices = [_Choice(content)]


class _Stream:
    def __init__(self, tokens, error_at=None, error=None):
        self.tokens = list(tokens)
        self.error_at = error_at
        self.error = error
        self.closed = False

    def __iter__(self):
        for i, tok in enumerate(self.tokens):
            if self.error_at is not None and i == self.error_at:
                raise self.error
            yield _Chunk(tok)

    def close(self):
        self.closed = True


class _FakeCompletions:
    def __init__(self, tokens=None, error_at=None, error=None, record=None):
        self.tokens = tokens or []
        self.error_at = error_at
        self.error = error
        self.record = record if record is not None else []

    def create(self, **kwargs):
        self.record.append(kwargs)
        if self.error is not None and self.error_at is None and not self.tokens:
            raise self.error  # fail before first token
        return _Stream(self.tokens, self.error_at, self.error)


class _FakeChat:
    def __init__(self, **kw):
        self.completions = _FakeCompletions(**kw)


class _FakeClient:
    def __init__(self, **kw):
        self.chat = _FakeChat(**kw)


def patch_stream(monkeypatch, **kw):
    def factory(api_key, base_url=None):
        return _FakeClient(**kw)

    monkeypatch.setattr(m.openai, "OpenAI", factory)


def parse_sse(text):
    events = []
    for chunk in text.split("\n\n"):
        chunk = chunk.strip()
        if not chunk:
            continue
        ev, data = "message", ""
        for line in chunk.split("\n"):
            if line.startswith("event:"):
                ev = line[6:].strip()
            elif line.startswith("data:"):
                data += line[5:].strip()
        events.append((ev, json.loads(data)))
    return events


def stream(body):
    return client.post("/api/chat/stream", json=body)


def ok_body():
    return {"messages": [{"role": "user", "content": "Tell me a joke"}]}


# ---------------------------------------------------------------------------
# 14. stream completion
# ---------------------------------------------------------------------------
def test_stream_completion(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", TEST_KEY)
    patch_stream(monkeypatch, tokens=["Hello", " ", "world", "!"])
    r = stream(ok_body())
    assert r.status_code == 200
    assert "text/event-stream" in r.headers["content-type"]
    events = parse_sse(r.text)
    deltas = [d["delta"] for ev, d in events if ev == "message" and "delta" in d]
    assert "".join(deltas) == "Hello world!"
    done = [d for ev, d in events if ev == "done"]
    assert len(done) == 1
    assert done[0]["reply"] == "Hello world!"
    assert done[0]["model"] == "openai/gpt-oss-120b"


def test_stream_uses_selected_model(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", TEST_KEY)
    record = []
    patch_stream(monkeypatch, tokens=["x"], record=record)
    r = stream({"messages": [{"role": "user", "content": "hi"}], "model": "openai/gpt-oss-20b"})
    assert r.status_code == 200
    assert record[0]["model"] == "openai/gpt-oss-20b"
    assert record[0]["stream"] is True


# ---------------------------------------------------------------------------
# mid-stream + pre-stream failures
# ---------------------------------------------------------------------------
def test_stream_midway_provider_error(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", TEST_KEY)
    patch_stream(monkeypatch, tokens=["partial", "more"], error_at=1, error=FakeTimeoutError("timed out"))
    r = stream(ok_body())
    assert r.status_code == 200
    events = parse_sse(r.text)
    errs = [d for ev, d in events if ev == "error"]
    assert len(errs) == 1
    assert errs[0]["code"] == "provider_timeout"
    assert not [1 for ev, d in events if ev == "done"]


def test_stream_upfront_provider_error(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", TEST_KEY)
    patch_stream(monkeypatch, error=FakeStatusError(401))
    r = stream(ok_body())
    events = parse_sse(r.text)
    errs = [d for ev, d in events if ev == "error"]
    assert errs and errs[0]["code"] == "invalid_key"


def test_stream_empty_reply_is_error_event(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", TEST_KEY)
    patch_stream(monkeypatch, tokens=[])
    r = stream(ok_body())
    events = parse_sse(r.text)
    errs = [d for ev, d in events if ev == "error"]
    assert errs and errs[0]["code"] == "empty_reply"


def test_stream_validation_before_provider(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", TEST_KEY)
    patch_stream(monkeypatch, tokens=["never"])
    r = stream({"messages": [{"role": "user", "content": "hi"}], "model": "nope/nay"})
    assert r.status_code == 400
    assert r.json()["code"] == "bad_model"


def test_stream_without_key(monkeypatch):
    patch_stream(monkeypatch, tokens=["never"])
    r = stream(ok_body())
    assert r.status_code == 503
    assert r.json()["code"] == "no_api_key"


# ---------------------------------------------------------------------------
# 15. early client disconnect ends quietly
# ---------------------------------------------------------------------------
def test_stream_early_disconnect(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", TEST_KEY)
    patch_stream(monkeypatch, tokens=[f"tok{i} " for i in range(50)])
    got = []
    with client.stream("POST", "/api/chat/stream", json=ok_body()) as r:
        assert r.status_code == 200
        for line in r.iter_lines():
            if line.startswith("data:"):
                got.append(json.loads(line[5:]).get("delta", ""))
                if len(got) >= 3:
                    break  # hang up early — server must not blow up
    assert len(got) == 3
    assert "".join(got) == "tok0 tok1 tok2 "
