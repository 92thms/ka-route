# Klanavo - Demo unter [https://klanavo.zneb.to](https://klanavo.zneb.to)

Klanavo durchsucht eBay Kleinanzeigen entlang beliebiger Routen und zeigt die Treffer direkt auf einer Karte.

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

Das Frontend steht anschließend unter [http://localhost:8401](http://localhost:8401) bereit. Suchradius und Punktabstand werden im UI eingestellt. Ein Wartungsmodus lässt sich über `MAINTENANCE_MODE=1` und einen passenden `MAINTENANCE_KEY` aktivieren.

## Entwicklung
Backend und Frontend liegen unter `api/` bzw. `web/`. Das Backend basiert auf FastAPI und nutzt Playwright zum Scrapen. Die Weboberfläche ist statisch und benötigt keinen zusätzlichen Build-Schritt.

## Danksagung
Die Ermittlung der Inserate baut auf der großartigen Arbeit der [ebay-kleinanzeigen-api](https://github.com/DanielWTE/ebay-kleinanzeigen-api) auf. Vielen Dank an die Entwickler des Projekts.

## Lizenz
[MIT](LICENSE)
