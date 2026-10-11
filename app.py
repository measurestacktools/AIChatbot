"""AIChatbot backend — FastAPI + Groq (OpenAI-compatible API).

Serves the frontend from static/ and exposes a small JSON/SSE API for a
single-user AI chat app. Chat history lives in the browser (localStorage);
the Groq API key lives ONLY on the server (GROQ_API_KEY env var).
"""

from __future__ import annotations

import json
import os
import time
from collections import defaultdict, deque
from pathlib import Path
from typing import Any, Deque, Dict, List, Optional, Tuple

import openai
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
STATIC_DIR.mkdir(parents=True, exist_ok=True)

GROQ_BASE_URL = "https://api.groq.com/openai/v1"

# Server-side allowlist — verified against Groq docs (Oct 2026). Client may
# only pick from these; anything else is rejected with 400.
MODEL_ALLOWLIST = {
    "openai/gpt-oss-120b": "GPT-OSS 120B · most capable",
    "openai/gpt-oss-20b": "GPT-OSS 20B · fastest",
}
DEFAULT_MODEL = "openai/gpt-oss-120b"

# Request bounds (server-side, not negotiable from the client).
MAX_MESSAGES = 40          # conversation turns (user+assistant pairs bounded)
MAX_MSG_CHARS = 6000       # per message
MAX_TOTAL_CHARS = 24000    # whole history sent to the model
MAX_SYSTEM_CHARS = 1000    # custom system instructions
MIN_OUT_TOKENS = 64
MAX_OUT_TOKENS = 2048
DEFAULT_OUT_TOKENS = 1024
MIN_TEMP = 0.0
MAX_TEMP = 1.5
DEFAULT_TEMP = 0.7
PROVIDER_TIMEOUT = 60.0

# Gentle per-IP rate limit for chat endpoints (status/models are exempt).
RATE_LIMIT_MAX = 30
RATE_LIMIT_WINDOW = 60.0
_rate_hits: Dict[str, Deque[float]] = defaultdict(deque)

BASE_SYSTEM = (
    "You are ChatNova, a helpful, friendly AI assistant inside a small "
    "personal chatbot app. Answer clearly and concisely. Use Markdown "
    "formatting (headings, lists, tables, fenced code blocks with a language "
    "tag) when it makes the answer easier to read. If you are unsure, say so "
    "instead of inventing facts."
)

NO_KEY_MESSAGE = (
    "No Groq API key is configured on the server yet. "
    "Create a free key at https://console.groq.com/keys, put "
    "GROQ_API_KEY=gsk_... in a .env file (see .env.example), and restart the app."
)


def get_model() -> str:
    """Env override wins, but only if it names an allowlisted model."""
    wanted = (os.environ.get("GROQ_MODEL", "") or "").strip()
    if wanted in MODEL_ALLOWLIST:
        return wanted
    return DEFAULT_MODEL


def get_api_key() -> Optional[str]:
    return (os.environ.get("GROQ_API_KEY", "") or "").strip() or None


def get_openai_client(api_key: str) -> "openai.OpenAI":
    return openai.OpenAI(api_key=api_key, base_url=GROQ_BASE_URL)


def _rate_limited(ip: str) -> bool:
    now = time.monotonic()
    hits = _rate_hits[ip]
    while hits and now - hits[0] > RATE_LIMIT_WINDOW:
        hits.popleft()
    if len(hits) >= RATE_LIMIT_MAX:
        return True
    hits.append(now)
    return False


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return (request.client.host if request.client else "local") or "local"


def _provider_error_payload(exc: Exception) -> Tuple[int, str, str]:
    """Map provider/SDK failures to (status, friendly message, code).

    Never leaks tracebacks, keys, or raw provider internals.
    """
    auth_err = getattr(openai, "AuthenticationError", None)
    rate_err = getattr(openai, "RateLimitError", None)
    timeout_err = getattr(openai, "APITimeoutError", None)
    conn_err = getattr(openai, "APIConnectionError", None)
    if auth_err and isinstance(exc, auth_err):
        return 502, "Groq rejected the API key. Check GROQ_API_KEY and restart the app.", "invalid_key"
    if rate_err and isinstance(exc, rate_err):
        return 502, "Groq is rate-limiting right now. Wait a few seconds and retry.", "provider_rate_limited"
    if timeout_err and isinstance(exc, timeout_err):
        return 502, "Groq took too long to answer. Try again with a shorter message.", "provider_timeout"
    if conn_err and isinstance(exc, conn_err):
        return 502, "Could not reach Groq. Check your internet connection and retry.", "provider_unreachable"
    status = getattr(exc, "status_code", None)
    if status == 401:
        return 502, "Groq rejected the API key. Check GROQ_API_KEY and restart the app.", "invalid_key"
    if status == 429:
        return 502, "Groq is rate-limiting right now. Wait a few seconds and retry.", "provider_rate_limited"
    if "timeout" in type(exc).__name__.lower() or "timed out" in str(exc).lower():
        return 502, "Groq took too long to answer. Try again with a shorter message.", "provider_timeout"
    return 502, "The AI service hiccuped. Please try again.", "provider_error"


def _parse_temperature(value: Any) -> Tuple[Optional[float], Optional[str]]:
    if value is None:
        return DEFAULT_TEMP, None
    try:
        temp = float(value)
    except (TypeError, ValueError):
        return None, "Temperature must be a number."
    if not (MIN_TEMP <= temp <= MAX_TEMP):
        return None, f"Temperature must be between {MIN_TEMP} and {MAX_TEMP}."
    return temp, None


def _parse_max_tokens(value: Any) -> Tuple[Optional[int], Optional[str]]:
    if value is None:
        return DEFAULT_OUT_TOKENS, None
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None, "max_tokens must be a whole number."
    if isinstance(value, bool) or not (MIN_OUT_TOKENS <= n <= MAX_OUT_TOKENS):
        return None, f"max_tokens must be between {MIN_OUT_TOKENS} and {MAX_OUT_TOKENS}."
    return n, None


def _validate_messages(raw: Any) -> Tuple[Optional[List[Dict[str, str]]], Optional[str]]:
    if not isinstance(raw, list) or not raw:
        return None, "Send 1 to 40 messages as [{role, content}]."
    if len(raw) > MAX_MESSAGES:
        return None, (
            f"Too many messages ({len(raw)}). Send at most {MAX_MESSAGES} — "
            "start a new conversation for older topics."
        )
    cleaned: List[Dict[str, str]] = []
    total = 0
    for i, item in enumerate(raw):
        if not isinstance(item, dict):
            return None, f"Message #{i + 1} must be an object with role and content."
        role = item.get("role")
        content = item.get("content")
        if role not in ("user", "assistant"):
            return None, f"Message #{i + 1} has an invalid role (user or assistant only)."
        if not isinstance(content, str) or not content.strip():
            return None, f"Message #{i + 1} is empty. Type something first."
        content = content.strip()
        if len(content) > MAX_MSG_CHARS:
            return None, (
                f"Message #{i + 1} is too long ({len(content)} chars). "
                f"Keep each message under {MAX_MSG_CHARS} characters."
            )
        total += len(content)
        cleaned.append({"role": role, "content": content})
    if total > MAX_TOTAL_CHARS:
        return None, (
            f"Conversation too long ({total} chars). Keep history under "
            f"{MAX_TOTAL_CHARS} characters or start a new conversation."
        )
    if cleaned[-1]["role"] != "user":
        return None, "The last message must be from the user."
    return cleaned, None


def _validate_chat_payload(body: "ChatBody") -> Tuple[Optional[dict], Optional[dict]]:
    """Return (params, None) on success or (None, error_payload)."""
    messages, err = _validate_messages(body.messages)
    if err:
        return None, {"error": err, "code": "bad_request"}
    model = (body.model or "").strip() or get_model()
    if model not in MODEL_ALLOWLIST:
        return None, {
            "error": "That model is not available. Pick one from the model list.",
            "code": "bad_model",
        }
    temperature, err = _parse_temperature(body.temperature)
    if err:
        return None, {"error": err, "code": "bad_request"}
    max_tokens, err = _parse_max_tokens(body.max_tokens)
    if err:
        return None, {"error": err, "code": "bad_request"}
    system = (body.system or "").strip()
    if len(system) > MAX_SYSTEM_CHARS:
        return None, {
            "error": f"Custom instructions too long ({len(system)} chars, max {MAX_SYSTEM_CHARS}).",
            "code": "bad_request",
        }
    full_system = BASE_SYSTEM + ("\n\nUser instructions: " + system if system else "")
    provider_messages = [{"role": "system", "content": full_system}] + messages
    return {
        "messages": provider_messages,
        "model": model,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }, None


def _groq_reply(api_key: str, params: dict) -> str:
    client = get_openai_client(api_key)
    resp = client.chat.completions.create(
        model=params["model"],
        messages=params["messages"],
        temperature=params["temperature"],
        max_tokens=params["max_tokens"],
        timeout=PROVIDER_TIMEOUT,
    )
    return (resp.choices[0].message.content or "").strip()


def _groq_stream(api_key: str, params: dict):
    client = get_openai_client(api_key)
    return client.chat.completions.create(
        model=params["model"],
        messages=params["messages"],
        temperature=params["temperature"],
        max_tokens=params["max_tokens"],
        timeout=PROVIDER_TIMEOUT,
        stream=True,
    )


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(title="AIChatbot")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.exception_handler(Exception)
async def unhandled_handler(request: Request, exc: Exception):
    from fastapi import HTTPException

    if isinstance(exc, HTTPException):
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": str(exc.detail), "code": "http_error"},
        )
    return JSONResponse(
        status_code=500,
        content={"error": "Something went sideways. Please try again.", "code": "internal"},
    )


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    """Serve the app icon so browsers never 404 on /favicon.ico."""
    return FileResponse(str(STATIC_DIR / "favicon.svg"), media_type="image/svg+xml")


@app.get("/")
def home():
    index = STATIC_DIR / "index.html"
    if index.is_file():
        return FileResponse(str(index), media_type="text/html")
    return HTMLResponse(
        "<!doctype html><html><body>"
        "<h1>AIChatbot</h1>"
        "<p>Backend is running. Frontend files are on their way.</p>"
        "</body></html>"
    )


@app.get("/api/status")
def api_status():
    key = get_api_key()
    model = get_model()
    if key:
        return {
            "ok": True,
            "configured": True,
            "source": "env",
            "model": model,
            "models": [{"id": mid, "label": label} for mid, label in MODEL_ALLOWLIST.items()],
            "message": "ChatNova is ready! Your Groq key is loaded from the server .env file.",
        }
    return {
        "ok": True,
        "configured": False,
        "source": None,
        "model": model,
        "models": [{"id": mid, "label": label} for mid, label in MODEL_ALLOWLIST.items()],
        "message": NO_KEY_MESSAGE,
    }


@app.get("/api/models")
def api_models():
    return {
        "ok": True,
        "default": get_model(),
        "models": [{"id": mid, "label": label} for mid, label in MODEL_ALLOWLIST.items()],
    }


class ChatBody(BaseModel):
    messages: Any = None
    model: str = ""
    temperature: Any = None
    max_tokens: Any = None
    system: str = ""


def _guard(request: Request) -> Optional[JSONResponse]:
    if _rate_limited(_client_ip(request)):
        return JSONResponse(
            status_code=429,
            content={"error": "Slow down a little — too many requests. Try again in a minute.", "code": "rate_limited"},
        )
    api_key = get_api_key()
    if not api_key:
        return JSONResponse(status_code=503, content={"error": NO_KEY_MESSAGE, "code": "no_api_key"})
    return None


@app.post("/api/chat")
def api_chat(body: ChatBody, request: Request):
    blocked = _guard(request)
    if blocked:
        return blocked
    params, err = _validate_chat_payload(body)
    if err:
        return JSONResponse(status_code=400, content=err)
    try:
        reply = _groq_reply(get_api_key() or "", params)
    except Exception as exc:  # mapped, never raw
        status, message, code = _provider_error_payload(exc)
        return JSONResponse(status_code=status, content={"error": message, "code": code})
    if not reply:
        return JSONResponse(
            status_code=502,
            content={"error": "The AI answered with nothing. Try again.", "code": "empty_reply"},
        )
    return {"ok": True, "reply": reply, "model": params["model"]}


@app.post("/api/chat/stream")
def api_chat_stream(body: ChatBody, request: Request):
    blocked = _guard(request)
    if blocked:
        return blocked
    params, err = _validate_chat_payload(body)
    if err:
        return JSONResponse(status_code=400, content=err)
    api_key = get_api_key() or ""

    def event_generator():
        full_parts: List[str] = []
        try:
            stream = _groq_stream(api_key, params)
            for chunk in stream:
                try:
                    delta = chunk.choices[0].delta.content or ""
                except (AttributeError, IndexError):
                    delta = ""
                if delta:
                    full_parts.append(delta)
                    yield f"data: {json.dumps({'delta': delta})}\n\n"
        except GeneratorExit:
            return  # client hung up (Stop button) — end quietly
        except Exception as exc:  # mapped, never raw
            _status, message, code = _provider_error_payload(exc)
            yield f"event: error\ndata: {json.dumps({'error': message, 'code': code})}\n\n"
            return
        reply = "".join(full_parts).strip()
        if not reply:
            yield (
                "event: error\ndata: "
                + json.dumps({"error": "The AI answered with nothing. Try again.", "code": "empty_reply"})
                + "\n\n"
            )
            return
        yield f"event: done\ndata: {json.dumps({'reply': reply, 'model': params['model']})}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8005"))
    uvicorn.run(app, host="127.0.0.1", port=port)
