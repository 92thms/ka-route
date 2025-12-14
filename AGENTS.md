# Repository Guidelines

## Project Structure & Module Organization
- `api/` FastAPI service with HTTP-based Kleinanzeigen scraper (entrypoint `api/main.py`); bundled upstream scraper code lives in `api/ebay-kleinanzeigen-api/`.
- `web/` static frontend (HTML/JS/CSS) served by Nginx in production; copy `web/config.js.template` to `web/config.js` when customizing endpoints or maintenance mode text.
- `tests/` pytest suites using `fastapi.testclient` to exercise proxy and stats endpoints.
- `ops/` container runtime assets (Dockerfile, Nginx, supervisord) and `docker-compose.yml` for local orchestration; runtime data persists under `data/` (e.g., `data/stats.json`).

## Build, Test, and Development Commands
- Bootstrap env: `cp .env.example .env` then set `ORS_API_KEY` (and optional `USE_ORS_REVERSE`, `MAINTENANCE_*`).
- Full stack via Docker: `docker-compose up --build` (exposes UI on `http://localhost:8401`, mounts `./data`).
- Backend local dev (without Docker):  
  ```bash
  cd api
  pip install -r requirements.txt
  uvicorn api.main:app --reload --host 0.0.0.0 --port 8000
  ```
  Keine Browser nötig; HTTP-Scraper läuft ohne Playwright.
- Tests: `pytest tests` from repo root (uses TestClient; no network needed).

## Coding Style & Naming Conventions
- Python: follow PEP 8, 4-space indents, type hints as in `api/main.py`; keep module-level helpers private-ish with leading underscores when not part of the API surface.
- JavaScript/CSS: stick to the existing vanilla JS style in `web/route.js`/`route.css`; prefer small helpers over global mutations and align naming with current `route*` patterns.
- Config files: check in templates only; keep real secrets in `.env`.

## Testing Guidelines
- Framework: pytest with `fastapi.testclient`. Name files `test_*.py` and functions `test_*`.
- Prefer unit tests that monkeypatch network/fs (see `tests/test_proxy.py`, `tests/test_stats.py`); avoid live HTTP calls.
- Aim to cover edge cases around proxy host validation, visitor counting, and rate limiting before adding new endpoints.

## Commit & Pull Request Guidelines
- Commits should be short, imperative, and often prefixed with a type (`feat: ...`, `chore: ...`); keep one logical change per commit.
- PRs should describe intent, list key changes, and link issues when applicable; include screenshots/GIFs for UI tweaks and note config/env impacts (`ORS_API_KEY`, maintenance flags).
- Run `pytest tests` (or relevant subset) before raising a PR and mention the result; call out any skipped or flaky tests.

## Security & Configuration Tips
- Never hardcode API keys; rely on `.env` and Docker environment variables. `data/` is volume-mounted—avoid writing secrets there.
- The `/proxy` route only allows hosts in `PROXY_ALLOW_HOSTS`; update this env var rather than bypassing checks.
- For privacy, visitor IPs are hashed (`data/stats.json`); keep this behavior intact when extending stats collection.
