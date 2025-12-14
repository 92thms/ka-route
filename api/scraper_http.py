"""Lightweight HTTP scraper for Kleinanzeigen search results.

This avoids Playwright by fetching and parsing the HTML directly.
"""

from __future__ import annotations

import asyncio
import re
from typing import Any
from urllib.parse import urlencode

import httpx
from bs4 import BeautifulSoup
from fastapi import HTTPException

BASE_URL = "https://www.kleinanzeigen.de"

# Reuse a single client for connection pooling; protected by a lock for lazy init.
_client: httpx.AsyncClient | None = None
_client_lock = asyncio.Lock()

DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
}


async def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        async with _client_lock:
            if _client is None:
                _client = httpx.AsyncClient(headers=DEFAULT_HEADERS, timeout=30.0)
    return _client


async def close_http_client() -> None:
    """Close the shared HTTP client (used during shutdown)."""
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def build_search_url(
    query: str | None = None,
    location: str | None = None,
    radius: int | None = None,
    category_id: int | None = None,
    min_price: int | None = None,
    max_price: int | None = None,
    page: int = 1,
) -> str:
    """Mirror the Playwright scraper's URL building to keep parity."""
    if min_price is not None or max_price is not None:
        min_price_str = str(min_price) if min_price is not None else ""
        max_price_str = str(max_price) if max_price is not None else ""
        if location:
            location_slug = location.replace(" ", "-")
            if category_id is not None:
                search_path = (
                    f"/s-{location_slug}/preis:{min_price_str}:{max_price_str}/c{category_id}/seite:{page}"
                )
            else:
                search_path = (
                    f"/s-{location_slug}/preis:{min_price_str}:{max_price_str}/seite:{page}"
                )
        else:
            if category_id is not None:
                search_path = (
                    f"/s-preis:{min_price_str}:{max_price_str}/c{category_id}/seite:{page}"
                )
            else:
                search_path = f"/s-preis:{min_price_str}:{max_price_str}/seite:{page}"
    else:
        if location:
            location_slug = location.replace(" ", "-")
            if category_id is not None:
                search_path = f"/s-{location_slug}/c{category_id}/seite:{page}"
            else:
                search_path = f"/s-{location_slug}/seite:{page}"
        else:
            if category_id is not None:
                search_path = f"/s-/c{category_id}/seite:{page}"
            else:
                search_path = f"/s-seite:{page}"

    params: dict[str, str] = {}
    if query:
        params["keywords"] = query
    if location and not (min_price or max_price):
        params["locationStr"] = location
    if radius:
        params["radius"] = str(radius)

    return BASE_URL + search_path + ("?" + urlencode(params) if params else "")


def _strip_price(raw: str) -> str:
    cleaned = re.sub(r"[^\d]", "", raw or "")
    return cleaned


def _parse_ads(html: str) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html, "html.parser")
    results: list[dict[str, Any]] = []
    for item in soup.select(".ad-listitem:not(.is-topad):not(.badge-hint-pro-small-srp)"):
        article = item.find("article")
        if not article:
            continue
        adid = article.get("data-adid")
        href = article.get("data-href")
        if not adid or not href:
            continue
        title_el = article.select_one("h2.text-module-begin a.ellipsis")
        price_el = article.select_one("p.aditem-main--middle--price-shipping--price")
        desc_el = article.select_one("p.aditem-main--middle--description")
        title_text = title_el.get_text(strip=True) if title_el else ""
        price_text = _strip_price(price_el.get_text(" ", strip=True) if price_el else "")
        desc_text = desc_el.get_text(" ", strip=True) if desc_el else ""
        results.append(
            {
                "adid": adid,
                "url": f"{BASE_URL}{href}",
                "title": title_text,
                "price": price_text,
                "description": desc_text,
            }
        )
    return results


async def get_inserate_http(
    query: str | None = None,
    location: str | None = None,
    radius: int | None = None,
    category_id: int | None = None,
    min_price: int | None = None,
    max_price: int | None = None,
    page_count: int = 1,
) -> list[dict[str, Any]]:
    """Fetch Kleinanzeigen listings via HTTP parsing instead of Playwright."""
    client = await _get_client()
    results: list[dict[str, Any]] = []
    for page in range(1, page_count + 1):
        url = build_search_url(
            query=query,
            location=location,
            radius=radius,
            category_id=category_id,
            min_price=min_price,
            max_price=max_price,
            page=page,
        )
        try:
            resp = await client.get(url, follow_redirects=True)
            resp.raise_for_status()
        except Exception as exc:  # pragma: no cover - network errors
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        page_results = _parse_ads(resp.text)
        results.extend(page_results)
    return results


__all__ = ["get_inserate_http", "build_search_url", "close_http_client"]
