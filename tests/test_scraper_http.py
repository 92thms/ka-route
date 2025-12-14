import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from api.scraper_http import build_search_url, _parse_ads  # type: ignore


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
