from __future__ import annotations

import contextlib

import pytest

from speakeasy_agent import httpclient


@pytest.fixture(autouse=True)
async def _close_shared_http_session():
    """The vendor adapters share one process-owned aiohttp session, and aiohttp
    binds a session to the loop it was created on. Tests get a fresh loop each,
    so the session must not survive between them."""
    yield
    with contextlib.suppress(Exception):
        await httpclient.close_shared_session()
