import asyncio
import sys
from pathlib import Path

import httpx

sys.path.append(str(Path(__file__).resolve().parents[1]))

from api import scraper_http
from api.scraper_http import _parse_ads, build_search_url  # type: ignore


def test_build_search_url_includes_filters():
    url = build_search_url(
        query="fahrrad",
        location="12345",
        radius=10,
        category_id=12,
        min_price=100,
        max_price=500,
        page=2,
    )
    assert "fahrrad" in url
    assert "12345" in url
    assert "radius=10" in url
    assert "/preis:100:500/c12/seite:2" in url


def test_parse_ads_extracts_expected_fields():
    html = """
    <div class="ad-listitem">
      <article data-adid="321" data-href="/s-anzeige/tolles-rad/321">
        <h2 class="text-module-begin"><a class="ellipsis">Tolles Rad</a></h2>
        <div class="aditem-main--top--left">
          <i class="icon-pin-gray"></i> 76187 Karlsruhe + 12 km
        </div>
        <p class="aditem-main--middle--price-shipping--price">1.234 € VB</p>
        <p class="aditem-main--middle--description">Guter Zustand</p>
      </article>
    </div>
    <div class="ad-listitem is-topad">
      <article data-adid="999" data-href="/s-anzeige/ignore/999"></article>
    </div>
    """
    ads = _parse_ads(html)
    assert len(ads) == 1
    ad = ads[0]
    assert ad["adid"] == "321"
    assert ad["url"].endswith("/s-anzeige/tolles-rad/321")
    assert ad["price"] == "1234"
    assert "Tolles Rad" == ad["title"]
    assert "Guter Zustand" == ad["description"]
    assert ad["postal_code"] == "76187"
    assert ad["city"] == "Karlsruhe"


def test_scraper_retries_rate_limit(monkeypatch):
    class FakeClient:
        calls = 0

        async def get(self, url, follow_redirects=True):
            self.calls += 1
            request = httpx.Request("GET", url)
            if self.calls == 1:
                return httpx.Response(429, request=request)
            return httpx.Response(200, text="<html></html>", request=request)

    fake_client = FakeClient()

    async def fake_get_client():
        return fake_client

    async def no_sleep(delay):
        return None

    monkeypatch.setattr(scraper_http, "_get_client", fake_get_client)
    monkeypatch.setattr(scraper_http.asyncio, "sleep", no_sleep)

    result = asyncio.run(scraper_http.get_inserate_http(query="bike", location="76133"))

    assert result == []
    assert fake_client.calls == 2
