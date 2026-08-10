"""Small live smoke test for the Kleinanzeigen search-result parser."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from api.scraper_http import close_http_client, get_inserate_http


async def _check_parser() -> None:
    try:
        listings = await get_inserate_http(
            query="fahrrad",
            location="10115",
            radius=25,
            page_count=1,
        )
    finally:
        await close_http_client()

    if not listings:
        raise RuntimeError("Kleinanzeigen returned no parseable listings")

    titled = sum(bool(item.get("title")) for item in listings)
    linked = sum(
        str(item.get("url", "")).startswith(
            "https://www.kleinanzeigen.de/s-anzeige/"
        )
        for item in listings
    )
    priced = sum(bool(item.get("price")) for item in listings)
    located = sum(bool(item.get("postal_code") and item.get("city")) for item in listings)
    minimum = max(1, len(listings) // 2)

    checks = {
        "titles": titled,
        "links": linked,
        "prices": priced,
        "locations": located,
    }
    failed = [name for name, count in checks.items() if count < minimum]
    if failed:
        summary = ", ".join(f"{name}={checks[name]}" for name in failed)
        raise RuntimeError(
            f"Parser fields missing in too many of {len(listings)} listings: {summary}"
        )

    print(
        f"Parser OK: {len(listings)} listings, {titled} titles, {priced} prices, "
        f"{located} locations"
    )


if __name__ == "__main__":
    asyncio.run(_check_parser())
