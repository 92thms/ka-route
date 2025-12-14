# Schlankes Python-Image, Browser werden nicht benötigt
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1

# Systemdienste
RUN apt-get update \
 && apt-get install -y --no-install-recommends nginx supervisor wget ca-certificates gettext-base git \
 && rm -rf /var/lib/apt/lists/*

# Arbeitsverzeichnis
WORKDIR /app

# API-Code inklusive Kleinanzeigen-Scraper
COPY api /app/api
WORKDIR /app/api

# Python-Abhängigkeiten der API (falls vorhanden)
RUN if [ -f requirements.txt ]; then \
        pip install --no-cache-dir -r requirements.txt; \
    elif [ -f ebay-kleinanzeigen-api/requirements.txt ]; then \
        pip install --no-cache-dir -r ebay-kleinanzeigen-api/requirements.txt; \
    fi

# ensure uvicorn is available even if no requirements file is present
RUN pip install --no-cache-dir uvicorn

# Nginx & Supervisor Konfigs (liegen unter ops/)
WORKDIR /app
COPY ops/nginx.conf /etc/nginx/nginx.conf
COPY ops/supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY ops/start-nginx.sh /app/ops/start-nginx.sh
RUN chmod +x /app/ops/start-nginx.sh

# Frontend in Webroot (liegt unter web/)
COPY web /usr/share/nginx/html

# Nur Nginx nach außen exponieren
EXPOSE 80

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1/ || exit 1

# Start
CMD ["/usr/bin/supervisord","-c","/etc/supervisor/conf.d/supervisord.conf","-n"]
