"""API service for Klanavo."""

from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path
from typing import Optional, Any
import math
import json
import hashlib

from pydantic import BaseModel
import os
import socket
import ipaddress
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Request, Response
import httpx
from scraper_http import get_inserate_http, close_http_client


# Add the local Kleinanzeigen scraper to the import path
SCRAPER_DIR = Path(__file__).resolve().parent / "ebay-kleinanzeigen-api"
sys.path.insert(0, str(SCRAPER_DIR))

from scrapers.inserate import get_inserate_klaz  # type: ignore  # noqa: E402
from utils.browser import PlaywrightManager  # type: ignore  # noqa: E402


app = FastAPI()
"""FastAPI application used to expose the scraper."""

# Global Playwright browser so that it is not started for every request.  Starting
# and stopping Playwright is quite expensive, therefore we keep a single browser
# instance alive for the lifetime of the application and hand out new pages per
# request.
browser_manager: PlaywrightManager | None = None

# Simple global rate limiter: process at most one request per second.
RATE_LIMIT_SECONDS = 1.0
_last_request: float = 0.0
_rate_lock = asyncio.Lock()

# Global cache for reverse geocoded postal codes (plz, city)
_plz_cache: dict[str, tuple[str | None, str | None]] = {}

# Simple analytics storage; allow custom path via env variable
_STATS_FILE = Path(os.environ.get("STATS_FILE", "/data/stats.json"))
USE_PLAYWRIGHT = os.environ.get("USE_PLAYWRIGHT", "0").lower() not in {"0", "false", "no", ""}


def _get_allowed_hosts() -> set[str]:
    hosts = os.getenv(
        "PROXY_ALLOW_HOSTS",
        "nominatim.openstreetmap.org,www.kleinanzeigen.de",
    )
    return {h.strip().lower() for h in hosts.split(",") if h.strip()}


def _load_stats() -> dict[str, Any]:
    if _STATS_FILE.exists():
        try:
            data = json.loads(_STATS_FILE.read_text())
            data["visitors"] = set(data.get("visitors", []))
            return data
        except Exception:
            pass
    return {"searches_saved": 0, "listings_found": 0, "visitors": set()}


_stats: dict[str, Any] = _load_stats()


def _persist_stats() -> None:
    data = {
        "searches_saved": _stats.get("searches_saved", 0),
        "listings_found": _stats.get("listings_found", 0),
        "visitors": list(_stats.get("visitors", set())),
    }
    try:
        _STATS_FILE.parent.mkdir(parents=True, exist_ok=True)
        _STATS_FILE.write_text(json.dumps(data))
    except Exception:
        pass


def _anonymise_ip(ip: str) -> str:
    return hashlib.sha256(ip.encode("utf-8")).hexdigest()


async def _fetch_listings(
    query: str | None,
    location: str | None,
    radius: int,
    min_price: Optional[int],
    max_price: Optional[int],
    category: Optional[int],
    page_count: int = 1,
) -> list[dict]:
    """Prefer HTTP scraping; fall back to Playwright when enabled and available."""
    last_error: HTTPException | None = None
    try:
        return await get_inserate_http(
            query=query,
            location=location,
            radius=radius,
            min_price=min_price,
            max_price=max_price,
            category_id=category,
            page_count=page_count,
        )
    except HTTPException as exc:
        last_error = exc
    except Exception as exc:  # pragma: no cover - defensive
        last_error = HTTPException(status_code=500, detail=str(exc))

    if USE_PLAYWRIGHT and browser_manager is not None:
        return await get_inserate_klaz(
            browser_manager=browser_manager,
            query=query,
            location=location,
            radius=radius,
            min_price=min_price,
            max_price=max_price,
            category_id=category,
            page_count=page_count,
        )

    if last_error:
        raise last_error

    raise HTTPException(status_code=503, detail="Browser not initialised")


def _get_client_ip(request: Request) -> Optional[str]:
    for header in (
        "X-Forwarded-For",
        "X-Real-IP",
        "CF-Connecting-IP",
        "True-Client-IP",
    ):
        if value := request.headers.get(header):
            if header == "X-Forwarded-For":
                value = value.split(",")[0]
            return value.strip()
    if request.client:
        return request.client.host
    return None


@app.middleware("http")
async def _rate_limit(request: Request, call_next) -> Response:
    """Delay requests so that at most one is handled per second."""
    global _last_request
    async with _rate_lock:
        now = time.monotonic()
        wait = RATE_LIMIT_SECONDS - (now - _last_request)
        if wait > 0:
            await asyncio.sleep(wait)
        _last_request = time.monotonic()
    return await call_next(request)


@app.on_event("startup")
async def _startup() -> None:
    """Initialise shared resources on application start."""
    global browser_manager
    if USE_PLAYWRIGHT:
        browser_manager = PlaywrightManager()
        await browser_manager.start()


@app.on_event("shutdown")
async def _shutdown() -> None:  # pragma: no cover - defensive programming
    """Close the Playwright browser when the application shuts down."""
    if browser_manager is not None:
        await browser_manager.close()
    await close_http_client()


@app.get("/health")
async def health() -> dict[str, str]:
    """Simple health check endpoint."""
    return {"status": "ok"}


@app.get("/inserate")
@app.get("/api/inserate")
async def inserate(
    query: str,
    location: str,
    radius: int = 10,
    min_price: Optional[int] = None,
    max_price: Optional[int] = None,
    category: Optional[int] = None,
    page_count: int = 1,
) -> dict[str, list]:
    """Return classifieds scraped from eBay Kleinanzeigen.

    Parameters
    ----------
    query:
        Search term for the classifieds.
    location:
        Postal code used as search origin.
    radius:
        Search radius in kilometres. Defaults to ``10``.
    min_price, max_price:
        Optional price filters in Euro.
    page_count:
        Number of result pages to fetch.  The upstream scraper supports up to
        20 pages.

    Returns
    -------
    dict
        A dictionary with a ``data`` key containing the scraped classifieds.
    """

    listings = await _fetch_listings(
        query=query,
        location=location,
        radius=radius,
        min_price=min_price,
        max_price=max_price,
        category=category,
        page_count=page_count,
    )

    return {"data": listings}


class RouteSearchRequest(BaseModel):
    start: str
    ziel: str
    radius: int = 10
    step: int = 10
    query: Optional[str] = None
    min_price: Optional[int] = None
    max_price: Optional[int] = None
    category: Optional[int] = None


async def _geocode_text(client: httpx.AsyncClient, api_key: str, text: str) -> tuple[float, float]:
    params = {"text": text, "boundary.country": "DE", "size": 1}
    try:
        resp = await client.get(
            "https://api.openrouteservice.org/geocode/search",
            params=params,
            headers={"Authorization": api_key},
        )
        resp.raise_for_status()
        data = resp.json()
        features = data.get("features") or []
        if features:
            coords = features[0]["geometry"]["coordinates"]
            return coords[0], coords[1]
    except Exception:
        pass

    try:
        resp = await client.get(
            "https://nominatim.openstreetmap.org/search",
            params={
                "q": text,
                "format": "jsonv2",
                "limit": 1,
                "countrycodes": "de",
            },
            headers={"User-Agent": "ka-route/1.0"},
        )
        resp.raise_for_status()
        data = resp.json()
        if data:
            return float(data[0]["lon"]), float(data[0]["lat"])
    except Exception:
        pass

    raise HTTPException(status_code=502, detail="Geocoding failed")


def _sample_route(coords: list[list[float]], step_m: float) -> list[list[float]]:
    samples: list[list[float]] = []
    acc = 0.0
    prev = coords[0]
    for cur in coords[1:]:
        dx = (cur[0] - prev[0]) * 111320 * math.cos(math.radians((cur[1] + prev[1]) / 2))
        dy = (cur[1] - prev[1]) * 110540
        dist = math.hypot(dx, dy)
        acc += dist
        if acc >= step_m:
            samples.append(cur)
            acc = 0.0
            prev = cur
        else:
            prev = cur
    return samples


async def _reverse_plz(client: httpx.AsyncClient, api_key: str, lat: float, lon: float) -> tuple[str | None, str | None]:
    key = f"{lat:.3f}|{lon:.3f}"
    if key in _plz_cache:
        return _plz_cache[key]
    plz: str | None = None
    city: str | None = None
    try:
        resp = await client.get(
            "https://api.openrouteservice.org/geocode/reverse",
            params={"point.lat": lat, "point.lon": lon, "size": 1},
            headers={"Authorization": api_key},
        )
        if resp.status_code == 200:
            data = resp.json()
            props = data.get("features", [{}])[0].get("properties", {})
            plz = props.get("postalcode")
            city = props.get("locality") or props.get("region") or props.get("name")
    except Exception:
        pass
    if not plz:
        try:
            resp = await client.get(
                "https://nominatim.openstreetmap.org/reverse",
                params={
                    "lat": lat,
                    "lon": lon,
                    "format": "jsonv2",
                    "zoom": 10,
                    "addressdetails": 1,
                },
                headers={"User-Agent": "ka-route/1.0"},
            )
            if resp.status_code == 200:
                j = resp.json()
                plz = j.get("address", {}).get("postcode")
                city = (
                    j.get("address", {}).get("city")
                    or j.get("address", {}).get("town")
                    or j.get("address", {}).get("village")
                    or j.get("address", {}).get("state")
                )
        except Exception:
            pass
    _plz_cache[key] = (plz, city)
    return plz, city


@app.post("/route-search")
@app.post("/api/route-search")
async def route_search(req: RouteSearchRequest, request: Request) -> dict:
    if USE_PLAYWRIGHT and browser_manager is None:  # pragma: no cover - defensive
        raise HTTPException(status_code=503, detail="Browser not initialised")
    api_key = os.getenv("ORS_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="ORS_API_KEY not configured")

    async with httpx.AsyncClient() as client:
        start_ll = await _geocode_text(client, api_key, req.start)
        ziel_ll = await _geocode_text(client, api_key, req.ziel)
        resp = await client.post(
            "https://api.openrouteservice.org/v2/directions/driving-car/geojson",
            json={"coordinates": [start_ll, ziel_ll]},
            headers={"Authorization": api_key},
        )
        resp.raise_for_status()
        route = resp.json()
        coords = route["features"][0]["geometry"]["coordinates"]

        samples = _sample_route(coords, req.step * 1000)
        plzs: set[str] = set()
        plz_coords: dict[str, tuple[float, float]] = {}
        plz_labels: dict[str, str] = {}
        for lon, lat in samples:
            plz, city = await _reverse_plz(client, api_key, lat, lon)
            if plz:
                plzs.add(plz)
                plz_coords.setdefault(plz, (lat, lon))
                if city:
                    plz_labels.setdefault(plz, f"{plz} {city}")
                else:
                    plz_labels.setdefault(plz, plz)

        results: list[dict] = []
        seen: set[str] = set()
        for plz in plzs:
            try:
                items = await _fetch_listings(
                    query=req.query,
                    location=plz,
                    radius=req.radius,
                    min_price=req.min_price,
                    max_price=req.max_price,
                    category=req.category,
                )
            except Exception:
                continue
            for it in items:
                url = it.get("url")
                if url in seen:
                    continue
                seen.add(url)
                it["plz"] = plz
                if label := plz_labels.get(plz):
                    it["label"] = label
                if coords_plz := plz_coords.get(plz):
                    it["lat"], it["lon"] = coords_plz
                results.append(it)

    _stats["searches_saved"] += 1
    _stats["listings_found"] += len(results)
    ip = _get_client_ip(request)
    if ip:
        _stats["visitors"].add(_anonymise_ip(ip))
    _persist_stats()

    return {"route": coords, "listings": results}


@app.get("/stats")
@app.get("/api/stats")
def stats(request: Request) -> dict[str, int]:
    ip = _get_client_ip(request)
    if ip:
        _stats["visitors"].add(_anonymise_ip(ip))
        _persist_stats()
    return {
        "searches_saved": _stats["searches_saved"],
        "listings_found": _stats["listings_found"],
        "visitors": len(_stats["visitors"]),
    }


@app.get("/proxy")
async def proxy(u: str) -> Response:
    """Fetch ``u`` and return the raw response body.

    The route acts as a lightweight HTTP proxy used by the front-end to
    bypass CORS restrictions when fetching external resources such as
    Nominatim or individual Kleinanzeigen pages.
    """

    parsed = urlparse(u)
    if parsed.scheme not in {"http", "https"}:
        raise HTTPException(status_code=403, detail="invalid scheme")
    host = parsed.hostname
    if host is None or host.lower() not in _get_allowed_hosts():
        raise HTTPException(status_code=403, detail="host not allowed")

    try:
        for info in socket.getaddrinfo(host, None):
            ip = ipaddress.ip_address(info[4][0])
            if ip.is_private or ip.is_loopback:
                raise HTTPException(status_code=403, detail="invalid ip")
    except HTTPException:
        raise
    except Exception as exc:  # pragma: no cover - DNS failure
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "de-DE,de;q=0.9",
        "Referer": "https://www.kleinanzeigen.de/",
        "Cache-Control": "no-cache",
    }

    try:
        async with httpx.AsyncClient(follow_redirects=True) as client:
            resp = await client.get(u, headers=headers)
    except Exception as exc:  # pragma: no cover - network issues
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    content_type = resp.headers.get("content-type", "text/html")
    return Response(content=resp.content, status_code=resp.status_code, media_type=content_type)


@app.api_route("/ors/{path:path}", methods=["GET", "POST"])
async def ors_proxy(path: str, request: Request) -> Response:
    """Proxy requests to the OpenRouteService API using a server-side API key."""

    api_key = os.getenv("ORS_API_KEY")
    if not api_key:  # pragma: no cover - configuration issue
        raise HTTPException(status_code=500, detail="ORS_API_KEY not configured")

    url = f"https://api.openrouteservice.org/{path}"
    headers = {"Authorization": api_key}
    if ct := request.headers.get("content-type"):
        headers["Content-Type"] = ct

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.request(
                request.method,
                url,
                params=dict(request.query_params),
                content=await request.body(),
                headers=headers,
            )
    except Exception as exc:  # pragma: no cover - network issues
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    media_type = resp.headers.get("content-type", "application/json")
    return Response(content=resp.content, status_code=resp.status_code, media_type=media_type)
