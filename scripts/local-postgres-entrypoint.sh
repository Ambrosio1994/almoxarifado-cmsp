#!/usr/bin/env bash
set -euo pipefail

CERT_TARGET="/var/lib/postgresql/certs"
mkdir -p "$CERT_TARGET"

if [ -f /cert-source/local-dev-server.crt ] && [ -f /cert-source/local-dev-server.key ] && [ -f /cert-source/local-dev-ca.crt ]; then
  cp /cert-source/local-dev-server.crt "$CERT_TARGET/server.crt"
  cp /cert-source/local-dev-server.key "$CERT_TARGET/server.key"
  cp /cert-source/local-dev-ca.crt "$CERT_TARGET/ca.crt"
  chown -R postgres:postgres "$CERT_TARGET"
  chmod 644 "$CERT_TARGET/server.crt" "$CERT_TARGET/ca.crt"
  chmod 600 "$CERT_TARGET/server.key"
fi

exec docker-entrypoint.sh postgres \
  -c ssl=on \
  -c ssl_cert_file="$CERT_TARGET/server.crt" \
  -c ssl_key_file="$CERT_TARGET/server.key" \
  -c ssl_ca_file="$CERT_TARGET/ca.crt" \
  -c listen_addresses='*'
