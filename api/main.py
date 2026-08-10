"""API service for Klanavo."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import ipaddress
import json
import logging
import math
import os
import socket
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx
from fastapi import FastAPI, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field, model_validator

try:
    from .scraper_http import close_http_client, get_inserate_http
except ImportError:  # pragma: no cover - supports `uvicorn main:app` in api/
    from scraper_http import close_http_client, get_inserate_http

logger = logging.getLogger(__name__)


@asynccontextmanager
async def _lifespan(app: FastAPI):
    yield
    await close_http_client()


app = FastAPI(lifespan=_lifespan)
"""FastAPI application used to expose the scraper."""


def _maintenance_enabled() -> bool:
    return os.getenv("MAINTENANCE_MODE", "0").lower() in {"1", "true", "yes"}


def _maintenance_authorized(request: Request) -> bool:
    expected_key = os.getenv("MAINTENANCE_KEY", "")
    supplied_key = request.headers.get("X-Maintenance-Key", "")
    return bool(expected_key) and hmac.compare_digest(supplied_key, expected_key)


@app.middleware("http")
async def _protect_maintenance_mode(request: Request, call_next) -> Response:
    public_paths = {"/health", "/maintenance-auth", "/api/maintenance-auth"}
    if (
        _maintenance_enabled()
        and request.url.path not in public_paths
        and not _maintenance_authorized(request)
    ):
        return Response(
            content=json.dumps({"detail": "maintenance authentication required"}),
            status_code=401,
            media_type="application/json",
        )
    return await call_next(request)


@app.post("/maintenance-auth")
@app.post("/api/maintenance-auth")
async def maintenance_auth(request: Request) -> dict[str, bool]:
    if not _maintenance_enabled() or _maintenance_authorized(request):
        return {"authenticated": True}
    raise HTTPException(status_code=401, detail="invalid maintenance key")

# Serialize only upstream scraper calls. Health, stats and geocoding remain responsive.
RATE_LIMIT_SECONDS = float(os.getenv("SCRAPER_RATE_LIMIT_SECONDS", "1.0"))
_last_scrape_request: float = 0.0
_scrape_lock = asyncio.Lock()
NOMINATIM_RATE_LIMIT_SECONDS = float(
    os.getenv("NOMINATIM_RATE_LIMIT_SECONDS", "1.1")
)
_last_nominatim_request: float = 0.0
_nominatim_lock = asyncio.Lock()

# Global cache for reverse geocoded postal codes (plz, city)
_plz_cache: dict[str, tuple[str | None, str | None]] = {}

# Simple analytics storage; allow custom path via env variable
_STATS_FILE = Path(os.environ.get("STATS_FILE", "/data/stats.json"))
_stats_lock = threading.Lock()


def _get_allowed_hosts() -> set[str]:
    hosts = os.getenv(
        "PROXY_ALLOW_HOSTS",
        "nominatim.openstreetmap.org,www.kleinanzeigen.de",
    )
    return {h.strip().lower() for h in hosts.split(",") if h.strip()}


def _load_stats() -> dict[str, Any]:
    if _STATS_FILE.exists():
        try:
            data = json.loads(_STATS_FILE.read_text(encoding="utf-8"))
            return {
                "searches_saved": max(0, int(data.get("searches_saved", 0))),
                "listings_found": max(0, int(data.get("listings_found", 0))),
                "visitors": {
                    value
                    for value in data.get("visitors", [])
                    if isinstance(value, str)
                },
            }
        except (OSError, TypeError, ValueError, json.JSONDecodeError) as exc:
            logger.warning("Could not load stats from %s: %s", _STATS_FILE, exc)
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
        temporary_file = _STATS_FILE.with_suffix(f"{_STATS_FILE.suffix}.tmp")
        temporary_file.write_text(json.dumps(data), encoding="utf-8")
        temporary_file.replace(_STATS_FILE)
    except OSError as exc:
        logger.warning("Could not persist stats to %s: %s", _STATS_FILE, exc)


def _anonymise_ip(ip: str) -> str:
    salt = os.getenv("STATS_HASH_SALT", "")
    return hashlib.sha256(f"{salt}\0{ip}".encode()).hexdigest()


async def _fetch_listings(
    query: str | None,
    location: str | None,
    radius: int,
    min_price: int | None,
    max_price: int | None,
    category: int | None,
    page_count: int = 1,
) -> list[dict]:
    """HTTP-only scraping."""
    global _last_scrape_request
    async with _scrape_lock:
        wait = RATE_LIMIT_SECONDS - (time.monotonic() - _last_scrape_request)
        if wait > 0:
            await asyncio.sleep(wait)
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
        finally:
            _last_scrape_request = time.monotonic()


def _normalise_ip(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return str(ipaddress.ip_address(value.strip()))
    except ValueError:
        return None


def _get_client_ip(request: Request) -> str | None:
    peer = request.client.host.strip() if request.client else None
    peer_ip = _normalise_ip(peer)
    trusted_proxies = {
        value.strip()
        for value in os.getenv("TRUSTED_PROXY_IPS", "127.0.0.1,::1").split(",")
        if value.strip()
    }
    if (peer_ip in trusted_proxies or peer in trusted_proxies) and (
        forwarded_ip := _normalise_ip(request.headers.get("X-Real-IP"))
    ):
        # Nginx overwrites X-Real-IP with the connected client's address.
        return forwarded_ip
    if peer_ip:
        return peer_ip
    return peer



@app.get("/health")
async def health() -> dict[str, str]:
    """Simple health check endpoint."""
    return {"status": "ok"}


@app.get("/inserate")
@app.get("/api/inserate")
async def inserate(
    query: str = Query(min_length=1, max_length=100),
    location: str = Query(pattern=r"^\d{5}$"),
    radius: int = Query(default=10, ge=0, le=200),
    min_price: int | None = Query(default=None, ge=0, le=100_000_000),
    max_price: int | None = Query(default=None, ge=0, le=100_000_000),
    category: int | None = Query(default=None, ge=0),
    page_count: int = Query(default=1, ge=1, le=20),
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

    if min_price is not None and max_price is not None and min_price > max_price:
        raise HTTPException(status_code=422, detail="min_price must not exceed max_price")

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
    start: str = Field(min_length=1, max_length=200)
    ziel: str = Field(min_length=1, max_length=200)
    start_coordinates: tuple[float, float] | None = None
    ziel_coordinates: tuple[float, float] | None = None
    radius: int = Field(default=10, ge=0, le=200)
    step: int = Field(default=10, ge=1, le=100)
    query: str | None = Field(default=None, max_length=100)
    min_price: int | None = Field(default=None, ge=0, le=100_000_000)
    max_price: int | None = Field(default=None, ge=0, le=100_000_000)
    category: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def validate_price_range(self) -> RouteSearchRequest:
        if (
            self.min_price is not None
            and self.max_price is not None
            and self.min_price > self.max_price
        ):
            raise ValueError("min_price must not exceed max_price")
        for name, coordinates in (
            ("start_coordinates", self.start_coordinates),
            ("ziel_coordinates", self.ziel_coordinates),
        ):
            if coordinates is None:
                continue
            lon, lat = coordinates
            if not (5 < lon < 16 and 47 < lat < 56):
                raise ValueError(f"{name} must be inside Germany")
        return self


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
    except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError) as exc:
        logger.info("ORS geocoding failed for %r: %s", text, exc)

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
    except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError) as exc:
        logger.info("Nominatim geocoding failed for %r: %s", text, exc)

    raise HTTPException(status_code=502, detail="Geocoding failed")


def _sample_route(coords: list[list[float]], step_m: float) -> list[list[float]]:
    if not coords:
        return []
    if step_m <= 0:
        raise ValueError("step_m must be positive")
    samples: list[list[float]] = [coords[0]]
    distance_to_next_sample = step_m
    prev = coords[0]
    for cur in coords[1:]:
        segment_start = prev
        dx = (cur[0] - segment_start[0]) * 111320 * math.cos(
            math.radians((cur[1] + segment_start[1]) / 2)
        )
        dy = (cur[1] - segment_start[1]) * 110540
        segment_distance = math.hypot(dx, dy)
        while segment_distance >= distance_to_next_sample and segment_distance > 0:
            ratio = distance_to_next_sample / segment_distance
            sample = [
                segment_start[0] + (cur[0] - segment_start[0]) * ratio,
                segment_start[1] + (cur[1] - segment_start[1]) * ratio,
            ]
            samples.append(sample)
            segment_start = sample
            dx = (cur[0] - segment_start[0]) * 111320 * math.cos(
                math.radians((cur[1] + segment_start[1]) / 2)
            )
            dy = (cur[1] - segment_start[1]) * 110540
            segment_distance = math.hypot(dx, dy)
            distance_to_next_sample = step_m
        distance_to_next_sample -= segment_distance
        prev = cur
    if samples[-1] != coords[-1]:
        samples.append(coords[-1])
    return samples


async def _reverse_plz(client: httpx.AsyncClient, api_key: str, lat: float, lon: float) -> tuple[str | None, str | None]:
    global _last_nominatim_request
    key = f"{lat:.3f}|{lon:.3f}"
    if key in _plz_cache:
        return _plz_cache[key]
    plz: str | None = None
    city: str | None = None
    # Route searches already require ORS. Use it first and retry transient
    # failures instead of bulk-querying public Nominatim for every sample.
    for attempt in range(3):
        try:
            resp = await client.get(
                "https://api.openrouteservice.org/geocode/reverse",
                params={"point.lat": lat, "point.lon": lon, "size": 1},
                headers={"Authorization": api_key},
            )
            if resp.status_code == 200:
                data = resp.json()
                features = data.get("features") or []
                props = features[0].get("properties", {}) if features else {}
                plz = props.get("postalcode")
                city = props.get("locality") or props.get("region") or props.get("name")
                if plz:
                    break
            if resp.status_code not in {429, 500, 502, 503, 504}:
                break
        except (httpx.HTTPError, KeyError, TypeError, ValueError) as exc:
            logger.info("ORS reverse geocoding failed: %s", exc)
        if attempt < 2:
            await asyncio.sleep(0.5 * (attempt + 1))

    if not plz:
        # Public Nominatim is only a rate-limited fallback for route samples
        # where ORS returned no postal code. Listing enrichment never uses it.
        async with _nominatim_lock:
            wait = NOMINATIM_RATE_LIMIT_SECONDS - (
                time.monotonic() - _last_nominatim_request
            )
            if wait > 0:
                await asyncio.sleep(wait)
            try:
                response = await client.get(
                    "https://nominatim.openstreetmap.org/reverse",
                    params={
                        "lat": lat,
                        "lon": lon,
                        "format": "jsonv2",
                        "zoom": 10,
                        "addressdetails": 1,
                    },
                    headers={"User-Agent": "ka-route/1.0 (self-hosted)"},
                )
                if response.status_code == 200:
                    address = response.json().get("address", {})
                    plz = address.get("postcode")
                    city = (
                        address.get("city")
                        or address.get("town")
                        or address.get("village")
                        or address.get("municipality")
                        or address.get("state")
                    )
                else:
                    logger.warning(
                        "Nominatim reverse geocoding returned HTTP %s",
                        response.status_code,
                    )
            except (httpx.HTTPError, TypeError, ValueError) as exc:
                logger.warning("Nominatim reverse geocoding failed: %s", exc)
            finally:
                _last_nominatim_request = time.monotonic()

    # Do not cache transient misses; a later request should be allowed to retry.
    if plz:
        _plz_cache[key] = (plz, city)
    return plz, city


@app.post("/route-search")
@app.post("/api/route-search")
async def route_search(req: RouteSearchRequest, request: Request) -> dict:
    api_key = os.getenv("ORS_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="ORS_API_KEY not configured")

    timeout = httpx.Timeout(20.0, connect=10.0)
    async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
        start_ll = req.start_coordinates or await _geocode_text(
            client, api_key, req.start
        )
        ziel_ll = req.ziel_coordinates or await _geocode_text(
            client, api_key, req.ziel
        )
        try:
            route_response = await client.post(
                "https://api.openrouteservice.org/v2/directions/driving-car/geojson",
                json={"coordinates": [start_ll, ziel_ll]},
                headers={"Authorization": api_key},
            )
            route_response.raise_for_status()
            route = route_response.json()
            coords = route["features"][0]["geometry"]["coordinates"]
            if not isinstance(coords, list) or len(coords) < 2:
                raise ValueError("route contains too few coordinates")
        except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError) as exc:
            logger.warning("ORS route request failed: %s", exc)
            raise HTTPException(status_code=502, detail="Route calculation failed") from exc

        samples = _sample_route(coords, req.step * 1000)
        plzs: list[str] = []
        seen_plzs: set[str] = set()
        search_points: list[dict[str, Any]] = []
        resolved_samples = 0
        for lon, lat in samples:
            plz, city = await _reverse_plz(client, api_key, lat, lon)
            if plz:
                resolved_samples += 1
                search_points.append(
                    {
                        "lat": lat,
                        "lon": lon,
                        "postal_code": plz,
                        "city": city,
                    }
                )
                if plz not in seen_plzs:
                    seen_plzs.add(plz)
                    plzs.append(plz)

        results: list[dict] = []
        seen: set[str] = set()
        scrape_errors: list[str] = []
        successful_searches = 0
        for plz in plzs:
            logger.info(
                "Searching Kleinanzeigen around postal code %s (%s km radius)",
                plz,
                req.radius,
            )
            try:
                items = await _fetch_listings(
                    query=req.query,
                    location=plz,
                    radius=req.radius,
                    min_price=req.min_price,
                    max_price=req.max_price,
                    category=req.category,
                )
            except HTTPException as exc:
                logger.warning("Scraping failed for postal code %s: %s", plz, exc)
                scrape_errors.append(f"Search failed for postal code {plz}")
                continue
            successful_searches += 1
            logger.info("Found %s listings around postal code %s", len(items), plz)
            for it in items:
                url = it.get("url")
                if url in seen:
                    continue
                seen.add(url)
                # Keep the route search origin only as diagnostics. It is not the
                # listing's location and must never be presented or pinned as such.
                it["search_postal_code"] = plz
                actual_postal_code = it.get("postal_code")
                if isinstance(actual_postal_code, str) and len(actual_postal_code) == 5:
                    it["plz"] = actual_postal_code
                    city = it.get("city")
                    it["label"] = (
                        f"{actual_postal_code} {city}" if city else actual_postal_code
                    )
                results.append(it)

    ip = _get_client_ip(request)
    with _stats_lock:
        _stats["searches_saved"] += 1
        _stats["listings_found"] += len(results)
        if ip:
            _stats["visitors"].add(_anonymise_ip(ip))
        _persist_stats()

    resp: dict = {
        "route": coords,
        "search_points": search_points,
        "listings": results,
        "coverage": {
            "route_samples": len(samples),
            "resolved_samples": resolved_samples,
            "search_locations": len(plzs),
            "successful_searches": successful_searches,
            "failed_searches": len(scrape_errors),
        },
    }
    if scrape_errors:
        resp["scrape_errors"] = scrape_errors
    return resp


@app.get("/stats")
@app.get("/api/stats")
def stats(request: Request) -> dict[str, int]:
    ip = _get_client_ip(request)
    with _stats_lock:
        if ip:
            visitor_hash = _anonymise_ip(ip)
            if visitor_hash not in _stats["visitors"]:
                _stats["visitors"].add(visitor_hash)
                _persist_stats()
        return {
            "searches_saved": _stats["searches_saved"],
            "listings_found": _stats["listings_found"],
            "visitors": len(_stats["visitors"]),
        }


def _validate_proxy_url(url: str) -> tuple[str, int]:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise HTTPException(status_code=403, detail="invalid scheme")
    if parsed.username or parsed.password:
        raise HTTPException(status_code=403, detail="credentials not allowed")
    host = parsed.hostname
    if host is None or host.lower() not in _get_allowed_hosts():
        raise HTTPException(status_code=403, detail="host not allowed")
    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail="invalid port") from exc
    if port not in {80, 443}:
        raise HTTPException(status_code=403, detail="port not allowed")
    return host, port


def _ensure_public_host(host: str, port: int) -> None:
    try:
        addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        if not addresses:
            raise OSError("host did not resolve")
        for info in addresses:
            if not ipaddress.ip_address(info[4][0]).is_global:
                raise HTTPException(status_code=403, detail="invalid ip")
    except HTTPException:
        raise
    except OSError as exc:  # pragma: no cover - environment-specific DNS failures
        logger.warning("Proxy DNS lookup failed for %s: %s", host, exc)
        raise HTTPException(status_code=502, detail="upstream DNS lookup failed") from exc


@app.get("/proxy")
async def proxy(u: str = Query(max_length=2_048)) -> Response:
    """Fetch ``u`` and return the raw response body.

    The route acts as a lightweight HTTP proxy used by the front-end to
    bypass CORS restrictions when fetching external resources such as
    Nominatim or individual Kleinanzeigen pages.
    """

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

    current_url = u
    timeout = httpx.Timeout(20.0, connect=10.0)
    try:
        async with httpx.AsyncClient(
            follow_redirects=False,
            http2=True,
            timeout=timeout,
            trust_env=False,
        ) as client:
            for _ in range(4):
                host, port = _validate_proxy_url(current_url)
                _ensure_public_host(host, port)
                upstream_response = await client.get(current_url, headers=headers)
                if upstream_response.is_redirect:
                    location = upstream_response.headers.get("location")
                    if not location:
                        break
                    current_url = urljoin(current_url, location)
                    continue
                break
            else:
                raise HTTPException(status_code=502, detail="too many redirects")
    except HTTPException:
        raise
    except httpx.HTTPError as exc:  # pragma: no cover - network issues
        logger.warning("Proxy request failed: %s", exc)
        raise HTTPException(status_code=502, detail="upstream request failed") from exc

    max_bytes = int(os.getenv("PROXY_MAX_RESPONSE_BYTES", "5000000"))
    if len(upstream_response.content) > max_bytes:
        raise HTTPException(status_code=502, detail="upstream response too large")
    return Response(
        content=upstream_response.content,
        status_code=upstream_response.status_code,
        headers={
            # Proxy responses are parsed as text by the frontend. Never serve
            # third-party HTML as executable content on the app's own origin.
            "Content-Type": "text/plain; charset=utf-8",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'",
        },
    )


@app.api_route("/ors/{path:path}", methods=["GET", "POST"])
async def ors_proxy(path: str, request: Request) -> Response:
    """Proxy requests to the OpenRouteService API using a server-side API key."""

    api_key = os.getenv("ORS_API_KEY")
    if not api_key:  # pragma: no cover - configuration issue
        raise HTTPException(status_code=500, detail="ORS_API_KEY not configured")

    allowed_get_paths = {
        "geocode/autocomplete",
        "geocode/reverse",
        "geocode/search",
        "geocode/search/structured",
    }
    allowed_post_paths = {"v2/directions/driving-car/geojson"}
    allowed_paths = allowed_get_paths if request.method == "GET" else allowed_post_paths
    if path not in allowed_paths:
        raise HTTPException(status_code=403, detail="ORS path not allowed")

    url = f"https://api.openrouteservice.org/{path}"
    headers = {"Authorization": api_key}
    if ct := request.headers.get("content-type"):
        headers["Content-Type"] = ct

    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(20.0, connect=10.0), trust_env=False
        ) as client:
            resp = await client.request(
                request.method,
                url,
                params=request.query_params.multi_items(),
                content=await request.body(),
                headers=headers,
            )
    except httpx.HTTPError as exc:  # pragma: no cover - network issues
        logger.warning("ORS proxy request failed: %s", exc)
        raise HTTPException(status_code=502, detail="ORS request failed") from exc

    content_type = resp.headers.get("content-type", "application/json")
    return Response(
        content=resp.content,
        status_code=resp.status_code,
        headers={"Content-Type": content_type},
    )
