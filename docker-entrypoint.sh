#!/bin/sh
# Substitutes the CLIENT_KEY env var into the shipped JS at container start, so the
# real value only ever lives in the deploy environment (Portainer/compose), never in
# the repo. Keep CLIENT_KEY to letters/digits (e.g. `openssl rand -hex 24`) - the sed
# delimiter below assumes it contains no "|" characters.
set -eu
if [ -n "${CLIENT_KEY:-}" ]; then
  sed -i "s|__CLIENT_KEY__|$CLIENT_KEY|g" /www/js/sync.js
fi
exec httpd -f -v -p 80 -h /www
