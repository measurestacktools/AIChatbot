"""Backend contract tests — Groq is mocked by monkeypatching openai.OpenAI.

Covers: startup, status, missing key, invalid input, empty/oversized
messages, bad model, server-side key handling, history validation, provider
success, timeout, rate limit, invalid key, and generic provider errors.

Run: pytest tests/   (no real API key needed)
"""

import json
import re

import pytest
from fastapi.testclient import TestClient

import app as m

client = TestClient(m.app)

TEST_KEY = "gsk_test_key_123"

# A real Groq key is gsk_ + ~50 secret chars. Setup guides legitimately
# mention the placeholder "gsk_..." — only long secrets count as leaks.
REAL_KEY_RE = re.compile(r"gsk_[A-Za-z0-9]{10,}")


@pytest.fixture(autouse=True)
def clean_state(monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.delenv("GROQ_MODEL", raising=False)
    m._rate_hits.clear()
    yield
    m._rate_hits.clear()


# ---------------------------------------------------------------------------
# Fake Groq client
# ---------------------------------------------------------------------------
class _FakeMessage:
    def __init__(self, content):
        self.content = content


class _FakeChoice:
    def __init__(self, content):
        self.message = _FakeMessage(content)


class _FakeResp:
    def __init__(self, content):
        self.choices = [_FakeChoice(content)]


class _FakeCompletions:
    def __init__(self, script=None, error=None, record=None):
        self.script = list(script or [])
        self.error = error
        self.record = record if record is not None else []

    def create(self, **kwargs):
        self.record.append(kwargs)
        if self.error:
            raise self.error
        if self.script:
            return _FakeResp(self.script.pop(0))
        return _FakeResp("Default mock reply.")


class _FakeChat:
    def __init__(self, script=None, error=None, record=None):
        self.completions = _FakeCompletions(script, error, record)


class _FakeClient:
    def __init__(self, script=None, error=None, record=None):
        self.record = record if record is not None else []
        self.chat = _FakeChat(script, error, self.record)


def patch_groq(monkeypatch, script=None, error=None, record=None):
    seen = {"key": None}

    def factory(api_key, base_url=None):
        seen["key"] = api_key
        return _FakeClient(script=script, error=error, record=record)

    monkeypatch.setattr(m.openai, "OpenAI", factory)
    return seen


def with_key(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", TEST_KEY)


def chat(body):
    return client.post("/api/chat", json=body)


def ok_body(**over):
    body = {"messages": [{"role": "user", "content": "Hello there"}]}
    body.update(over)
    return body


class FakeStatusError(Exception):
    def __init__(self, status_code):
        super().__init__(f"provider said {status_code}")
        self.status_code = status_code


class FakeTimeoutError(Exception):
    pass


# ---------------------------------------------------------------------------
# 1. startup / 2. status
# ---------------------------------------------------------------------------
def test_home_serves_frontend():
    r = client.get("/")
    assert r.status_code == 200
    assert "ChatNova" in r.text
    assert not REAL_KEY_RE.search(r.text)  # setup guide shows only gsk_... placeholder


def test_status_unconfigured_shape():
    r = client.get("/api/status")
    assert r.status_code == 200
    d = r.json()
    assert d["ok"] is True
    assert d["configured"] is False
    assert d["source"] is None
    assert d["model"] == "openai/gpt-oss-120b"
    assert {m["id"] for m in d["models"]} == {"openai/gpt-oss-120b", "openai/gpt-oss-20b"}
    assert not REAL_KEY_RE.search(json.dumps(d))


def test_status_configured_with_env_key(monkeypatch):
    with_key(monkeypatch)
    d = client.get("/api/status").json()
    assert d["configured"] is True
    assert d["source"] == "env"
    assert TEST_KEY not in json.dumps(d)


def test_models_endpoint():
    d = client.get("/api/models").json()
    assert d["ok"] is True
    assert d["default"] == "openai/gpt-oss-120b"
    assert len(d["models"]) == 2


def test_env_model_override_validated(monkeypatch):
    monkeypatch.setenv("GROQ_MODEL", "openai/gpt-oss-20b")
    assert client.get("/api/models").json()["default"] == "openai/gpt-oss-20b"
    monkeypatch.setenv("GROQ_MODEL", "evil/model")
    assert client.get("/api/models").json()["default"] == "openai/gpt-oss-120b"


# ---------------------------------------------------------------------------
# 3. missing key / 8. key handling
# ---------------------------------------------------------------------------
def test_chat_without_key_is_503_setup_message():
    r = chat(ok_body())
    assert r.status_code == 503
    d = r.json()
    assert d["code"] == "no_api_key"
    assert "Groq" in d["error"]


def test_env_key_is_used_and_never_leaked(monkeypatch):
    with_key(monkeypatch)
    seen = patch_groq(monkeypatch, script=["Hi!"])
    r = chat(ok_body())
    assert r.status_code == 200
    assert seen["key"] == TEST_KEY
    assert TEST_KEY not in r.text


# ---------------------------------------------------------------------------
# 4/5/6/7/9. input validation
# ---------------------------------------------------------------------------
def test_empty_messages_rejected(monkeypatch):
    with_key(monkeypatch)
    patch_groq(monkeypatch)
    assert chat({"messages": []}).status_code == 400
    assert chat({"messages": [{"role": "user", "content": "   "}]}).status_code == 400
    assert chat({}).status_code == 400


def test_bad_roles_rejected(monkeypatch):
    with_key(monkeypatch)
    patch_groq(monkeypatch)
    assert chat({"messages": [{"role": "system", "content": "hi"}]}).status_code == 400
    assert chat({"messages": [{"role": "user", "content": "hi"}, {"role": "bot", "content": "yo"}]}).status_code == 400


def test_last_message_must_be_user(monkeypatch):
    with_key(monkeypatch)
    patch_groq(monkeypatch)
    r = chat({"messages": [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}]})
    assert r.status_code == 400


def test_oversized_requests_rejected(monkeypatch):
    with_key(monkeypatch)
    patch_groq(monkeypatch)
    assert chat({"messages": [{"role": "user", "content": "x" * 6001}]}).status_code == 400
    many = [{"role": "user" if i % 2 == 0 else "assistant", "content": "m"} for i in range(41)]
    many = many[:-1] + [{"role": "user", "content": "last"}]
    assert chat({"messages": many}).status_code == 400


def test_unsupported_model_rejected(monkeypatch):
    with_key(monkeypatch)
    patch_groq(monkeypatch)
    r = chat(ok_body(model="llama-3.1-8b-instant"))
    assert r.status_code == 400
    assert r.json()["code"] == "bad_model"
    r = chat(ok_body(model="evil/model; rm -rf"))
    assert r.status_code == 400


def test_temperature_and_tokens_validated(monkeypatch):
    with_key(monkeypatch)
    patch_groq(monkeypatch)
    assert chat(ok_body(temperature=99)).status_code == 400
    assert chat(ok_body(temperature="hot")).status_code == 400
    assert chat(ok_body(max_tokens=10)).status_code == 400
    assert chat(ok_body(max_tokens=99999)).status_code == 400
    assert chat(ok_body(system="x" * 1001)).status_code == 400


def test_multiturn_history_accepted_and_forwarded(monkeypatch):
    with_key(monkeypatch)
    record = []
    patch_groq(monkeypatch, script=["Reply!"], record=record)
    msgs = [
        {"role": "user", "content": "What is 2+2?"},
        {"role": "assistant", "content": "4"},
        {"role": "user", "content": "And 3+3?"},
    ]
    r = chat({"messages": msgs, "system": "Be brief."})
    assert r.status_code == 200
    sent = record[0]["messages"]
    assert sent[0]["role"] == "system"
    assert "Be brief." in sent[0]["content"]
    assert [x["role"] for x in sent[1:]] == ["user", "assistant", "user"]
    assert record[0]["temperature"] == 0.7
    assert record[0]["max_tokens"] == 1024


# ---------------------------------------------------------------------------
# 10/11/12/13/20. provider outcomes
# ---------------------------------------------------------------------------
def test_provider_success(monkeypatch):
    with_key(monkeypatch)
    patch_groq(monkeypatch, script=["Mocked **answer** here."])
    r = chat(ok_body(model="openai/gpt-oss-20b", temperature=0.2, max_tokens=256))
    assert r.status_code == 200
    d = r.json()
    assert d["ok"] is True
    assert d["reply"] == "Mocked **answer** here."
    assert d["model"] == "openai/gpt-oss-20b"


def test_provider_invalid_key(monkeypatch):
    with_key(monkeypatch)
    patch_groq(monkeypatch, error=FakeStatusError(401))
    r = chat(ok_body())
    assert r.status_code == 502
    assert r.json()["code"] == "invalid_key"
    assert "traceback" not in r.text.lower()


def test_provider_timeout(monkeypatch):
    with_key(monkeypatch)
    patch_groq(monkeypatch, error=FakeTimeoutError("timed out"))
    r = chat(ok_body())
    assert r.status_code == 502
    assert r.json()["code"] == "provider_timeout"


def test_provider_rate_limit(monkeypatch):
    with_key(monkeypatch)
    patch_groq(monkeypatch, error=FakeStatusError(429))
    r = chat(ok_body())
    assert r.status_code == 502
    assert r.json()["code"] == "provider_rate_limited"


def test_provider_generic_error_is_friendly(monkeypatch):
    with_key(monkeypatch)
    patch_groq(monkeypatch, error=RuntimeError("super secret stack trace details"))
    r = chat(ok_body())
    assert r.status_code == 502
    d = r.json()
    assert d["code"] == "provider_error"
    assert "secret" not in r.text


def test_empty_provider_reply(monkeypatch):
    with_key(monkeypatch)
    patch_groq(monkeypatch, script=["   "])
    r = chat(ok_body())
    assert r.status_code == 502
    assert r.json()["code"] == "empty_reply"


def test_local_rate_limiter(monkeypatch):
    with_key(monkeypatch)
    patch_groq(monkeypatch, script=["ok"])
    for _ in range(30):
        assert chat(ok_body()).status_code == 200
    r = chat(ok_body())
    assert r.status_code == 429
    assert r.json()["code"] == "rate_limited"
