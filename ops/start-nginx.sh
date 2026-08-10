#!/bin/sh
set -eu

: "${MAINTENANCE_MODE:=0}"
: "${MAINTENANCE_KEY:=}"
: "${USE_ORS_REVERSE:=0}"

# shellcheck disable=SC2016
envsubst '${MAINTENANCE_MODE} ${USE_ORS_REVERSE}' \
    < /usr/share/nginx/html/config.js.template \
    > /usr/share/nginx/html/config.js

exec /usr/sbin/nginx -g 'daemon off;'
