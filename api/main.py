"""API service for Klanavo."""

from __future__ import annotations

import time
import asyncio
from contextlib import asynccontextmanager
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


@asynccontextmanager
async def _lifespan(app: FastAPI):
    yield
    await close_http_client()


app = FastAPI(lifespan=_lifespan)

# Per-IP rate limit: each client may send at most one request per second.
_ip_rate: dict[str, float] = {}  # ip -> monotonic time when next request is allowed
_rate_lock = asyncio.Lock()
IP_RATE_INTERVAL = 1.0

# Global cache for reverse geocoded postal codes (plz, city)
_plz_cache: dict[str, tuple[str | None, str | None]] = {}

# Simple analytics storage; allow custom path via env variable
_STATS_FILE = Path(os.environ.get("STATS_FILE", "/data/stats.json"))
_stats_lock = asyncio.Lock()

# ORS paths the frontend is allowed to reach through the proxy.
_ALLOWED_ORS_PATHS = frozenset({
    "geocode/autocomplete",
    "geocode/search",
    "geocode/search/structured",
})

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
    """HTTP-only scraping."""
    return await get_inserate_http(
        query=query,
        location=location,
        radius=radius,
        min_price=min_price,
        max_price=max_price,
        category_id=category,
        page_count=page_count,
    )


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
    """Per-IP rate limiter: at most one request per second per client."""
    ip = _get_client_ip(request) or "unknown"
    wait = 0.0
    async with _rate_lock:
        now = time.monotonic()
        # Evict stale entries older than 60 s to keep memory bounded.
        stale = [k for k, v in _ip_rate.items() if v < now - 60]
        for k in stale:
            del _ip_rate[k]
        next_allowed = _ip_rate.get(ip, 0.0)
        wait = max(0.0, next_allowed - now)
        _ip_rate[ip] = max(now, next_allowed) + IP_RATE_INTERVAL
    if wait > 0:
        await asyncio.sleep(wait)
    return await call_next(request)



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
    if not coords:
        return []
    samples: list[list[float]] = [coords[0]]
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
    if samples[-1] is not coords[-1]:
        samples.append(coords[-1])
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
        scrape_errors: list[str] = []
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
            except Exception as exc:
                scrape_errors.append(str(exc))
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

    async with _stats_lock:
        _stats["searches_saved"] += 1
        _stats["listings_found"] += len(results)
        ip = _get_client_ip(request)
        if ip:
            _stats["visitors"].add(_anonymise_ip(ip))
    _persist_stats()

    resp: dict = {"route": coords, "listings": results}
    if scrape_errors:
        resp["scrape_errors"] = scrape_errors
    return resp


@app.get("/stats")
@app.get("/api/stats")
async def stats(request: Request) -> dict[str, int]:
    ip = _get_client_ip(request)
    async with _stats_lock:
        if ip:
            _stats["visitors"].add(_anonymise_ip(ip))
        result = {
            "searches_saved": _stats["searches_saved"],
            "listings_found": _stats["listings_found"],
            "visitors": len(_stats["visitors"]),
        }
    if ip:
        _persist_stats()
    return result


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
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept-Encoding": "gzip, deflate, br",
        "Referer": "https://www.kleinanzeigen.de/",
        "Cache-Control": "max-age=0",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
        "sec-ch-ua": '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
    }

    try:
        async with httpx.AsyncClient(follow_redirects=True, http2=True) as client:
            resp = await client.get(u, headers=headers)
    except Exception as exc:  # pragma: no cover - network issues
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    content_type = resp.headers.get("content-type", "text/html")
    return Response(content=resp.content, status_code=resp.status_code, media_type=content_type)


@app.get("/ors/{path:path}")
async def ors_proxy(path: str, request: Request) -> Response:
    """Proxy geocoding requests to ORS using the server-side API key.

    Only the geocoding endpoints used by the frontend are allowed; routing
    and other ORS features are blocked to prevent API-key abuse.
    """
    if path not in _ALLOWED_ORS_PATHS:
        raise HTTPException(status_code=403, detail="endpoint not allowed")

    api_key = os.getenv("ORS_API_KEY")
    if not api_key:  # pragma: no cover - configuration issue
        raise HTTPException(status_code=500, detail="ORS_API_KEY not configured")

    url = f"https://api.openrouteservice.org/{path}"
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                url,
                params=dict(request.query_params),
                headers={"Authorization": api_key},
            )
    except Exception as exc:  # pragma: no cover - network issues
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    media_type = resp.headers.get("content-type", "application/json")
    return Response(content=resp.content, status_code=resp.status_code, media_type=media_type)
