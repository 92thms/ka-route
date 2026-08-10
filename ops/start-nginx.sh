#!/bin/sh
set -eu

: "${MAINTENANCE_MODE:=0}"
: "${MAINTENANCE_KEY:=}"

# shellcheck disable=SC2016
envsubst '${MAINTENANCE_MODE}' \
    < /usr/share/nginx/html/config.js.template \
    > /usr/share/nginx/html/config.js

exec /usr/sbin/nginx -g 'daemon off;'
