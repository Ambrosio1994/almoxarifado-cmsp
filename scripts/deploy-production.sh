#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DOMAIN="${PRODUCTION_DOMAIN:-sapgestao.dpdns.org}"
APP_PORT="${APP_PORT:-3000}"
COMPOSE=(docker compose --env-file .env.production -f compose.production.yml)
STATE_DIR="$ROOT_DIR/.deploy"

usage() {
  echo "Uso: $0 {check|backup|deploy|smoke|rollback}"
  echo "Dominio padrao: sapgestao.dpdns.org"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || { echo "Comando obrigatorio ausente: $1" >&2; exit 1; }
}

require_environment() {
  [[ -f .env.production ]] || { echo "Crie .env.production a partir de .env.production.example." >&2; exit 1; }
  [[ "$(stat -c '%a' .env.production)" =~ ^(600|400)$ ]] || { echo ".env.production deve ter permissao 600 ou 400." >&2; exit 1; }
  NODE_ENV=production ENV_FILE=.env.production npm run validate:production
}

check_dns() {
  require_command getent
  getent ahosts "$DOMAIN" >/dev/null || { echo "DNS de $DOMAIN nao resolve." >&2; exit 1; }
  echo "DNS de $DOMAIN resolve corretamente. Confirme manualmente A/AAAA contra o IP deste servidor."
}

compose_check() {
  require_command docker
  docker compose version >/dev/null
  "${COMPOSE[@]}" config --quiet
}

wait_ready() {
  local url="http://127.0.0.1:${APP_PORT}/health/ready"
  for _ in $(seq 1 30); do
    if curl --fail --silent --show-error "$url" >/dev/null; then
      echo "Readiness local aprovada."
      return 0
    fi
    sleep 2
  done
  echo "Readiness local falhou em 60 segundos." >&2
  return 1
}

smoke() {
  require_command curl
  curl --fail --silent --show-error "https://${DOMAIN}/health/live" >/dev/null
  curl --fail --silent --show-error "https://${DOMAIN}/health/ready" >/dev/null
  curl --fail --silent --show-error "https://${DOMAIN}/" >/dev/null
  curl --fail --silent --show-error "https://${DOMAIN}/api/processes" >/dev/null
  echo "Smoke test HTTPS aprovado em https://${DOMAIN}."
}

backup() {
  require_command pg_dump
  NODE_ENV=production npm run backup:production
}

preflight() {
  require_command node
  require_command npm
  require_command curl
  require_environment
  check_dns
  compose_check
  echo "Preflight aprovado sem exibir segredos."
}

deploy() {
  preflight
  require_command pg_dump
  npm ci
  npm test
  npm run check
  backup

  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
  local image rollback_tag
  image="$("${COMPOSE[@]}" config --images | head -n 1)"
  if docker image inspect "$image" >/dev/null 2>&1; then
    rollback_tag="${image}-rollback-$(date -u +%Y%m%dT%H%M%SZ)"
    docker image tag "$image" "$rollback_tag"
    printf '%s\n' "$rollback_tag" > "$STATE_DIR/previous-image"
    chmod 600 "$STATE_DIR/previous-image"
  fi

  "${COMPOSE[@]}" build --pull app
  NODE_ENV=production npm run db:migrate
  "${COMPOSE[@]}" up -d --no-deps app
  wait_ready || { echo "Execute '$0 rollback' para voltar a imagem anterior." >&2; return 1; }
  smoke
  echo "Deploy concluido. Migracoes sao forward-only; rollback automatico cobre somente a imagem."
}

rollback() {
  compose_check
  [[ -f "$STATE_DIR/previous-image" ]] || { echo "Imagem anterior nao registrada." >&2; exit 1; }
  local previous current
  previous="$(<"$STATE_DIR/previous-image")"
  current="$("${COMPOSE[@]}" config --images | head -n 1)"
  docker image inspect "$previous" >/dev/null
  docker image tag "$previous" "$current"
  "${COMPOSE[@]}" up -d --no-deps --force-recreate app
  wait_ready
  smoke
  echo "Rollback da aplicacao concluido; o schema Neon nao foi revertido."
}

case "${1:-}" in
  check) preflight ;;
  backup) require_environment; backup ;;
  deploy) deploy ;;
  smoke) smoke ;;
  rollback) rollback ;;
  -h|--help|help) usage ;;
  *) usage; exit 2 ;;
esac
