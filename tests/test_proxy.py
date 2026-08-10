import socket
import sys
from pathlib import Path

import httpx
from fastapi.testclient import TestClient

sys.path.append(str(Path(__file__).resolve().parents[1]))

from api.main import app


def _get_client():
    app.router.on_startup = []
    app.router.on_shutdown = []
    return TestClient(app)


def test_proxy_allows_host(monkeypatch):
    monkeypatch.setenv("PROXY_ALLOW_HOSTS", "example.com")

    async def fake_get(self, url, headers=None):
        return httpx.Response(200, content=b"ok", headers={"content-type": "text/html"})

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)

    def fake_getaddrinfo(host, port, *args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", 0))]

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)

    client = _get_client()
    resp = client.get("/proxy", params={"u": "http://example.com/test"})
    assert resp.status_code == 200
    assert resp.text == "ok"
    assert resp.headers["content-type"].startswith("text/plain")
    assert resp.headers["x-content-type-options"] == "nosniff"
    assert resp.headers["content-security-policy"] == "default-src 'none'"


def test_proxy_blocks_disallowed_host(monkeypatch):
    monkeypatch.setenv("PROXY_ALLOW_HOSTS", "example.com")
    called = False

    async def fake_get(self, url, headers=None):
        nonlocal called
        called = True
        return httpx.Response(200, content=b"ok")

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)

    client = _get_client()
    resp = client.get("/proxy", params={"u": "http://blocked.example/test"})
    assert resp.status_code == 403
    assert not called


def test_proxy_blocks_private_ip(monkeypatch):
    monkeypatch.setenv("PROXY_ALLOW_HOSTS", "example.com")

    def fake_getaddrinfo(host, port, *args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("127.0.0.1", 0))]

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)

    called = False

    async def fake_get(self, url, headers=None):
        nonlocal called
        called = True
        return httpx.Response(200, content=b"ok")

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)

    client = _get_client()
    resp = client.get("/proxy", params={"u": "http://example.com"})
    assert resp.status_code == 403
    assert not called


def test_proxy_blocks_redirect_to_disallowed_host(monkeypatch):
    monkeypatch.setenv("PROXY_ALLOW_HOSTS", "example.com")

    def fake_getaddrinfo(host, port, *args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("8.8.8.8", port))]

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)
    calls = []

    async def fake_get(self, url, headers=None):
        calls.append(url)
        return httpx.Response(
            302,
            headers={"location": "http://blocked.example/private"},
        )

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    client = _get_client()
    resp = client.get("/proxy", params={"u": "http://example.com/start"})
    assert resp.status_code == 403
    assert calls == ["http://example.com/start"]


def test_proxy_blocks_nonstandard_port(monkeypatch):
    monkeypatch.setenv("PROXY_ALLOW_HOSTS", "example.com")
    client = _get_client()
    resp = client.get("/proxy", params={"u": "http://example.com:8080/test"})
    assert resp.status_code == 403
