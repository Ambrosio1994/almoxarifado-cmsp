#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="${ENV_FILE:-.env.production}"

read_env_value() {
  local key="$1" file="${2:-$ENV_FILE}" line value="" found=false first last
  [[ -f "$file" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ "$line" =~ ^[[:space:]]*${key}[[:space:]]*=(.*)$ ]]; then
      value="${BASH_REMATCH[1]}"
      value="${value#"${value%%[![:space:]]*}"}"
      value="${value%"${value##*[![:space:]]}"}"
      if (( ${#value} >= 2 )); then
        first="${value:0:1}"
        last="${value: -1}"
        if [[ "$first" == "$last" && ( "$first" == '"' || "$first" == "'" ) ]]; then
          value="${value:1:${#value}-2}"
        fi
      fi
      found=true
    fi
  done < "$file"
  [[ "$found" == true ]] || return 1
  printf '%s' "$value"
}

file_domain="$(read_env_value PRODUCTION_DOMAIN "$ENV_FILE" || true)"
file_app_port="$(read_env_value APP_PORT "$ENV_FILE" || true)"
DOMAIN="${PRODUCTION_DOMAIN:-${file_domain:-sapgestao.dpdns.org}}"
APP_PORT="${APP_PORT:-${file_app_port:-3000}}"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f compose.production.yml)
STATE_DIR="$ROOT_DIR/.deploy"
APP_RESTART_REQUIRED=false
UPLOAD_VOLUME_NAME="almoxarifado_uploads"

usage() {
  echo "Uso: $0 {check|backup|deploy|smoke|rollback|target}"
  echo "Dominio padrao: sapgestao.dpdns.org"
}

validate_runtime_target() {
  if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ || "$DOMAIN" == *".."* || ${#DOMAIN} -gt 253 ]]; then
    echo "PRODUCTION_DOMAIN deve conter somente um hostname valido, sem protocolo ou caminho." >&2
    return 1
  fi
  if [[ ! "$APP_PORT" =~ ^[1-9][0-9]{0,4}$ ]] || (( 10#$APP_PORT > 65535 )); then
    echo "APP_PORT deve ser um inteiro entre 1 e 65535." >&2
    return 1
  fi
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || { echo "Comando obrigatorio ausente: $1" >&2; exit 1; }
}

require_environment() {
  [[ -f "$ENV_FILE" ]] || { echo "Crie $ENV_FILE a partir de .env.production.example." >&2; exit 1; }
  [[ "$(stat -c '%a' "$ENV_FILE")" =~ ^(600|400)$ ]] || { echo "$ENV_FILE deve ter permissao 600 ou 400." >&2; exit 1; }
  NODE_ENV=production ENV_FILE="$ENV_FILE" npm run validate:production
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

verify_upload_mount() {
  local container_id mount_info mount_type mount_name
  container_id="$("${COMPOSE[@]}" ps -q app 2>/dev/null || true)"
  [[ -n "$container_id" ]] || { echo "Container da aplicacao nao encontrado para validar uploads." >&2; return 1; }
  mount_info="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data/uploads"}}{{.Type}}|{{.Name}}{{end}}{{end}}' "$container_id")"
  IFS='|' read -r mount_type mount_name <<<"$mount_info"
  if [[ "$mount_type" != "volume" || "$mount_name" != "$UPLOAD_VOLUME_NAME" ]]; then
    echo "O container nao esta usando o volume persistente esperado em /data/uploads." >&2
    return 1
  fi
  docker volume inspect "$UPLOAD_VOLUME_NAME" >/dev/null
  echo "Volume persistente de uploads validado: $UPLOAD_VOLUME_NAME."
}

check_upload_integrity() {
  echo "Executando o gate de migrations e validando referencias no PostgreSQL contra o volume persistente antes da troca da aplicacao."
  "${COMPOSE[@]}" run --rm --no-deps app npm start -- --check-upload-storage
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
  echo "Smoke test HTTPS aprovado em https://${DOMAIN}."
}

backup_raw() {
  NODE_ENV=production BACKUP_CONSISTENCY=application-stopped npm run backup:production
}

restart_app_after_backup() {
  [[ "$APP_RESTART_REQUIRED" == true ]] || return 0
  echo "Reiniciando a aplicacao pausada para o backup."
  if "${COMPOSE[@]}" start app; then
    APP_RESTART_REQUIRED=false
    return 0
  fi
  echo "Falha ao reiniciar a aplicacao apos o backup; execute '${COMPOSE[*]} start app' imediatamente." >&2
  return 1
}

backup_exit_cleanup() {
  local status="${1:-1}"
  trap - EXIT INT TERM HUP
  if [[ "$APP_RESTART_REQUIRED" == true ]]; then
    restart_app_after_backup || true
  fi
  exit "$status"
}

arm_backup_restart_trap() {
  APP_RESTART_REQUIRED=true
  trap 'backup_exit_cleanup "$?"' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

disarm_backup_restart_trap() {
  APP_RESTART_REQUIRED=false
  trap - EXIT INT TERM HUP
}

backup() {
  local container_id running mount_info mount_type mount_name mount_source
  container_id="$("${COMPOSE[@]}" ps -a -q app 2>/dev/null || true)"
  running="$("${COMPOSE[@]}" ps --status running -q app 2>/dev/null || true)"

  if [[ -n "$container_id" ]]; then
    mount_info="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data/uploads"}}{{.Type}}|{{.Name}}|{{.Source}}{{end}}{{end}}' "$container_id")"
    IFS='|' read -r mount_type mount_name mount_source <<<"$mount_info"
    if [[ "$mount_type" == "volume" && -n "$mount_name" ]]; then
      export BACKUP_UPLOAD_DOCKER_VOLUME="$mount_name"
    elif [[ "$mount_type" == "bind" && -n "$mount_source" ]]; then
      export BACKUP_UPLOAD_SOURCE="$mount_source"
    fi
  fi

  if [[ -n "$running" ]]; then
    echo "Pausando a aplicacao para obter banco e uploads no mesmo ponto logico."
    # Arm before `stop`: a signal received while Compose is stopping must also
    # attempt to bring the previously-running instance back.
    arm_backup_restart_trap
    "${COMPOSE[@]}" stop app
    if ! backup_raw; then
      restart_app_after_backup || return 1
      disarm_backup_restart_trap
      wait_ready || true
      return 1
    fi
    restart_app_after_backup || return 1
    disarm_backup_restart_trap
    wait_ready
    return
  fi

  backup_raw
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
  # The backup precedes every command that could execute application tests or
  # migrations. Tests use an isolated temporary store and no runtime DB URL.
  backup
  npm ci
  npm test
  npm run check

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
  check_upload_integrity
  "${COMPOSE[@]}" up -d --no-deps app
  verify_upload_mount
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
  verify_upload_mount
  wait_ready
  smoke
  echo "Rollback da aplicacao concluido; o schema Neon nao foi revertido."
}

main() {
  case "${1:-}" in
    -h|--help|help) usage; return ;;
  esac
  validate_runtime_target
  case "${1:-}" in
    check) preflight ;;
    backup) require_environment; backup ;;
    deploy) deploy ;;
    smoke) smoke ;;
    rollback) rollback ;;
    target) printf 'domain=%s\nport=%s\n' "$DOMAIN" "$APP_PORT" ;;
    *) usage; return 2 ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
