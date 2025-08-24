import sys
from pathlib import Path
from fastapi.testclient import TestClient

sys.path.append(str(Path(__file__).resolve().parents[1]))

from api import main


def _get_client(monkeypatch, tmp_path):
    main.app.router.on_startup = []
    main.app.router.on_shutdown = []
    monkeypatch.setattr(main, "_STATS_FILE", tmp_path / "stats.json")
    main._stats = {"searches_saved": 0, "listings_found": 0, "visitors": set()}
    return TestClient(main.app)


def test_unique_visitors_via_header(monkeypatch, tmp_path):
    client = _get_client(monkeypatch, tmp_path)
    resp = client.get("/stats", headers={"X-Forwarded-For": "1.2.3.4"})
    assert resp.json()["visitors"] == 1
    resp = client.get("/stats", headers={"X-Forwarded-For": "1.2.3.4"})
    assert resp.json()["visitors"] == 1
    resp = client.get("/stats", headers={"X-Forwarded-For": "5.6.7.8"})
    assert resp.json()["visitors"] == 2


def test_visitors_fallback_client_host(monkeypatch, tmp_path):
    client = _get_client(monkeypatch, tmp_path)
    resp = client.get("/stats")
    assert resp.json()["visitors"] == 1
    resp = client.get("/stats")
    assert resp.json()["visitors"] == 1
