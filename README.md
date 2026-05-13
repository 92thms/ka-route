# klanavo

Klanavo sucht Kleinanzeigen entlang einer Route und zeigt die Treffer auf einer interaktiven Karte. Start- und Zielort eingeben, Suchbegriff eingeben, fertig. Die App sampelt Punkte entlang der berechneten Route und sucht in einem konfigurierbaren Radius darum herum.

**Demo:** [https://klanavo.zneb.to](https://klanavo.zneb.to) — nur zu Testzwecken, bitte selbst hosten und eigene API-Keys verwenden.

## Funktionen

- Routenberechnung via OpenRouteService (ORS)
- Adress-Autocomplete via ORS Geocoding + Nominatim-Fallback
- Kleinanzeigen-Suche an Punkten entlang der Route
- Ergebnisse auf der Karte, gruppiert nach Ort oder Kategorie
- Preisfilter und Sortierung
- Responsives Webfrontend, kein Build-Schritt nötig

## Voraussetzungen

- Docker und Docker Compose
- OpenRouteService API-Key: [openrouteservice.org](https://openrouteservice.org)

## Quickstart

```bash
cp .env.example .env
# ORS_API_KEY in .env eintragen
docker compose up -d
```

Frontend läuft dann unter [http://localhost:8401](http://localhost:8401).

## Umgebungsvariablen

| Variable | Standard | Beschreibung |
|---|---|---|
| `ORS_API_KEY` | — | OpenRouteService API-Key (Pflicht) |
| `USE_ORS_REVERSE` | `0` | ORS für Reverse-Geocoding verwenden statt Nominatim |
| `MAINTENANCE_MODE` | `0` | App sperren, Zugang nur mit Key |
| `MAINTENANCE_KEY` | — | Passwort für Wartungsmodus |

## Updates

Das Docker-Image wird bei jedem Push auf `main` automatisch gebaut und als `ghcr.io/92thms/ka-route:latest` veröffentlicht. Auf dem Server reicht dann:

```bash
docker compose pull && docker compose up -d
```

Damit das funktioniert, muss das Paket auf GitHub unter *Packages → ka-route → Package settings* auf **Public** gestellt sein — oder man loggt sich mit `docker login ghcr.io` am Server ein.

## Projektstruktur

```
api/          FastAPI-Backend (Python)
web/          Statisches Frontend (HTML/CSS/JS)
ops/          Dockerfile + Nginx-Konfiguration
tests/        Pytest-Tests
```

## Entwicklung

Backend und Frontend lassen sich unabhängig voneinander bearbeiten. Das Backend (`api/main.py`) startet mit Uvicorn, das Frontend ist statisch und braucht keinen Build. Tests:

```bash
pip install -r api/requirements.txt pytest
pytest
```

Die Kleinanzeigen-Suche basiert auf [ebay-kleinanzeigen-api](https://github.com/DanielWTE/ebay-kleinanzeigen-api) von DanielWTE.

## Lizenz

[MIT](LICENSE)
