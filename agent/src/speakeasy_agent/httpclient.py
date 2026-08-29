"""One process-owned aiohttp session, shared by every vendor plugin.

Why this module exists at all: `livekit-plugins-*` call
`livekit.agents.utils.http_context.http_session()` when no session was handed to
them, and that helper reads a contextvar that ONLY the `AgentServer` job runner
ever sets. Our agent is deliberately a plain asyncio process (see main.py: that
is what makes the DIRECT guarantee structural), so the contextvar is never set
and the plugins raise:

    RuntimeError: Attempted to use an http session outside of a job context.
    This is probably because you are trying to use a plugin without using the
    agent worker api.

The tempting "fix" is to migrate to `AgentServer` - which would put a worker in
EVERY room and destroy the product principle. The correct fix is the one the
error message itself offers second: own a session and pass it in as a kwarg.

The session is created lazily and ONLY from async code, because
`aiohttp.ClientSession()` binds to the running loop at construction. Both call
sites obey that: `DeepgramSttProvider._impl_for` is reached from `start()`, and
`CartesiaTtsProvider._impl_for` from the `_synthesize` async generator. Provider
`aclose()` must NOT close it - it belongs to the process, and `main.py` closes it
once on shutdown.
"""

from __future__ import annotations

import asyncio
import logging

import aiohttp

logger = logging.getLogger(__name__)

# Mirrors what livekit's own http_context builds: plugins open many parallel
# requests to one host and the aiohttp default keepalive of 15s is far too short
# for a call that runs for minutes.
_LIMIT_PER_HOST = 50
_KEEPALIVE_TIMEOUT_S = 120.0

_session: aiohttp.ClientSession | None = None


def shared_session() -> aiohttp.ClientSession:
    """The process-wide session. MUST be called with a running event loop."""
    global _session
    if _session is None or _session.closed:
        try:
            asyncio.get_running_loop()
        except RuntimeError as exc:  # pragma: no cover - programming error
            raise RuntimeError(
                "shared_session() must be called from async code: aiohttp binds "
                "the session to the running event loop at construction"
            ) from exc
        connector = aiohttp.TCPConnector(
            limit_per_host=_LIMIT_PER_HOST,
            keepalive_timeout=_KEEPALIVE_TIMEOUT_S,
        )
        # No total timeout: this session carries long-lived WebSockets (Deepgram
        # listen, Cartesia tts). Per-request deadlines are set by the callers.
        _session = aiohttp.ClientSession(
            connector=connector,
            timeout=aiohttp.ClientTimeout(total=None, sock_connect=5),
        )
        logger.debug("created the shared aiohttp session")
    return _session


async def close_shared_session() -> None:
    """Called once from the agent's shutdown path. Safe to call twice."""
    global _session
    if _session is not None and not _session.closed:
        await _session.close()
    _session = None


__all__ = ["shared_session", "close_shared_session"]
