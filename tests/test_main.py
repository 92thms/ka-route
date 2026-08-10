import httpx
import pytest
from fastapi.testclient import TestClient

from api import main


@pytest.fixture
def client(monkeypatch):
    monkeypatch.delenv("MAINTENANCE_MODE", raising=False)
    return TestClient(main.app)


def test_sample_route_interpolates_regular_points():
    samples = main._sample_route([[8.0, 50.0], [8.2, 50.0]], 5_000)

    assert samples[0] == [8.0, 50.0]
    assert samples[-1] == [8.2, 50.0]
    assert 3 <= len(samples) <= 5
    assert samples[1][0] < samples[2][0]


def test_sample_route_rejects_non_positive_step():
    with pytest.raises(ValueError):
        main._sample_route([[8.0, 50.0], [8.2, 50.0]], 0)


def test_inserate_validates_bounds_before_scraping(client):
    response = client.get(
        "/api/inserate",
        params={"query": "bike", "location": "not-a-postcode", "page_count": 21},
    )

    assert response.status_code == 422


def test_route_search_validates_price_range(client):
    response = client.post(
        "/api/route-search",
        json={"start": "Berlin", "ziel": "Hamburg", "min_price": 10, "max_price": 5},
    )

    assert response.status_code == 422


def test_maintenance_mode_protects_api(monkeypatch):
    monkeypatch.setenv("MAINTENANCE_MODE", "1")
    monkeypatch.setenv("MAINTENANCE_KEY", "secret")
    client = TestClient(main.app)

    assert client.get("/api/stats").status_code == 401
    assert client.post("/api/maintenance-auth").status_code == 401
    assert (
        client.post(
            "/api/maintenance-auth", headers={"X-Maintenance-Key": "secret"}
        ).status_code
        == 200
    )
    assert client.get("/api/stats", headers={"X-Maintenance-Key": "secret"}).status_code == 200


def test_ors_proxy_rejects_arbitrary_keyed_endpoint(monkeypatch):
    monkeypatch.setenv("ORS_API_KEY", "secret")
    client = TestClient(main.app)

    response = client.get("/ors/elevation/line")

    assert response.status_code == 403


def test_route_search_returns_route_and_enriched_listing(monkeypatch, tmp_path):
    monkeypatch.setenv("ORS_API_KEY", "secret")
    monkeypatch.setattr(main, "_STATS_FILE", tmp_path / "stats.json")
    monkeypatch.setattr(
        main,
        "_stats",
        {"searches_saved": 0, "listings_found": 0, "visitors": set()},
    )

    async def fake_geocode(client, api_key, text):
        return (8.0, 50.0) if text == "Start" else (8.1, 50.0)

    async def fake_reverse(client, api_key, lat, lon):
        return "76133", "Karlsruhe"

    async def fake_fetch(**kwargs):
        return [
            {
                "adid": "1",
                "url": "https://www.kleinanzeigen.de/s-anzeige/1",
                "title": "Fahrrad",
                "price": "100",
            }
        ]

    async def fake_post(self, url, json, headers):
        return httpx.Response(
            200,
            json={
                "features": [
                    {"geometry": {"coordinates": [[8.0, 50.0], [8.1, 50.0]]}}
                ]
            },
            request=httpx.Request("POST", url),
        )

    monkeypatch.setattr(main, "_geocode_text", fake_geocode)
    monkeypatch.setattr(main, "_reverse_plz", fake_reverse)
    monkeypatch.setattr(main, "_fetch_listings", fake_fetch)
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    response = TestClient(main.app).post(
        "/api/route-search",
        json={"start": "Start", "ziel": "Ziel", "query": "Fahrrad"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["route"] == [[8.0, 50.0], [8.1, 50.0]]
    assert payload["listings"][0] == {
        "adid": "1",
        "url": "https://www.kleinanzeigen.de/s-anzeige/1",
        "title": "Fahrrad",
        "price": "100",
        "plz": "76133",
        "label": "76133 Karlsruhe",
        "lat": 50.0,
        "lon": 8.0,
    }
