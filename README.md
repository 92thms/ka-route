# Klanavo – Demo unter [https://klanavo.zneb.to](https://klanavo.zneb.to)

Klanavo durchsucht Kleinanzeigen entlang einer Route und zeigt Treffer auf der Karte. Das Deployment hier ist eine Demo – für verlässlichen Betrieb bitte selbst hosten und eigene API-Keys hinterlegen.

## Funktionen
- Routenplanung und Anzeige der Inserate auf einer Karte
- Preisfilter, Gruppierung und Sortierung der Ergebnisse
- Responsives Webfrontend

## Schnellstart
1. `cp .env.example .env` und eigenen `ORS_API_KEY` eintragen. Optional `USE_ORS_REVERSE=1` setzen.
2. `docker-compose up --build`

Nutzungsstatistiken werden in `data/stats.json` gespeichert. Das Verzeichnis
ist als Volume eingebunden, sodass die Werte auch nach einem Update erhalten
bleiben. IP-Adressen werden dabei gehasht.

Das Frontend steht anschließend unter [http://localhost:8401](http://localhost:8401) bereit. Wartungsmodus: `MAINTENANCE_MODE=1` plus `MAINTENANCE_KEY`.

## Entwicklung
Backend und Frontend liegen unter `api/` bzw. `web/`. Das Backend basiert auf FastAPI und scrapet per HTTP (ohne Browser). Die Weboberfläche ist statisch und benötigt keinen zusätzlichen Build-Schritt.

## Danksagung
Die Ermittlung der Inserate baut auf der großartigen Arbeit der [ebay-kleinanzeigen-api](https://github.com/DanielWTE/ebay-kleinanzeigen-api) auf. Vielen Dank an die Entwickler des Projekts.

## Lizenz
[MIT](LICENSE)
