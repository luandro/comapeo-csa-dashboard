#!/usr/bin/env bash
# Contrato de privacidade: dados brutos, polígonos privados e credenciais
# nunca entram no diretório de staging nem são enviados ao Surge.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
NO_FETCH=false
DOMAIN="csa-eco.surge.sh"
STAGING=""

usage() {
  cat <<'EOF'
Uso: scripts/deploy.sh [opções]

Atualiza os dados privados e publica o dashboard estático no Surge.

Opções:
  -n, --no-fetch       Não atualiza os dados antes da publicação
      --domain DOMÍNIO Domínio do Surge (padrão: csa-eco.surge.sh)
  -h, --help           Mostra esta ajuda
EOF
}

cleanup() {
  if [[ -n "$STAGING" && -d "$STAGING" && "$(basename "$STAGING")" == comapeo-csa-deploy.* ]]; then
    rm -rf -- "$STAGING"
  fi
}
trap cleanup EXIT

require_option_value() {
  local option="$1"
  local value="${2:-}"
  if [[ -z "$value" || "$value" == -* ]]; then
    printf 'Erro: %s requer um valor.\n' "$option" >&2
    exit 2
  fi
}

while (($#)); do
  case "$1" in
    -n|--no-fetch)
      NO_FETCH=true
      shift
      ;;
    --domain)
      require_option_value "$1" "${2:-}"
      DOMAIN="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      if (($#)); then
        printf 'Erro: argumentos posicionais não são aceitos.\n' >&2
        exit 2
      fi
      ;;
    *)
      printf 'Erro: opção desconhecida: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

DOMAIN="${DOMAIN#https://}"
DOMAIN="${DOMAIN#http://}"
DOMAIN="${DOMAIN%/}"
if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then
  printf 'Erro: domínio inválido. Informe somente o host, sem caminho.\n' >&2
  exit 2
fi

cd "$REPO_ROOT"

if [[ "$NO_FETCH" == false ]]; then
  ./scripts/fetch-data.sh
fi

required_files=(index.html app.js style.css data.js README.md)
for required_file in "${required_files[@]}"; do
  if [[ ! -f "$required_file" ]]; then
    printf 'Erro: arquivo obrigatório ausente: %s\n' "$required_file" >&2
    exit 1
  fi
done
for required_dir in data/photos docs; do
  if [[ ! -d "$required_dir" ]]; then
    printf 'Erro: diretório obrigatório ausente: %s\n' "$required_dir" >&2
    exit 1
  fi
done

STAGING="$(mktemp -d "${TMPDIR:-/tmp}/comapeo-csa-deploy.XXXXXX")"

cp index.html app.js style.css data.js README.md "$STAGING/"
mkdir -p "$STAGING/data"
cp -a data/photos "$STAGING/data/"
mkdir -p "$STAGING/docs"
find docs -type f -name '*.md' -exec cp --parents -- '{}' "$STAGING/" \;

violations=""
add_violation() {
  violations+="$1"$'\n'
}

while IFS= read -r -d '' staged_file; do
  relative_path="${staged_file#"$STAGING"/}"

  if LC_ALL=C grep -aqE '[A-F0-9]{64,}' "$staged_file"; then
    add_violation "Token-like value: $relative_path"
  fi

  if [[ "$relative_path" != "README.md" ]] && LC_ALL=C grep -aqF 'comapeo.cloud' "$staged_file"; then
    add_violation "Private server hostname: $relative_path"
  fi

  if [[ "$relative_path" != "README.md" ]]; then
    while IFS= read -r bearer_line; do
      bearer_value="${bearer_line#*SERVER_BEARER_TOKEN=}"
      bearer_value="${bearer_value%%[[:space:]#]*}"
      bearer_value="${bearer_value#\"}"
      bearer_value="${bearer_value%\"}"
      bearer_value="${bearer_value#\'}"
      bearer_value="${bearer_value%\'}"
      normalized_value="${bearer_value,,}"
      case "$normalized_value" in
        ""|"<"*">"|\$\{*\}|your-token|your_token|replace-me|replace_me|changeme|placeholder|example)
          ;;
        *)
          add_violation "Bearer token assignment: $relative_path"
          break
          ;;
      esac
    done < <(LC_ALL=C grep -aE 'SERVER_BEARER_TOKEN=[^[:space:]]+' "$staged_file" || true)
  fi
done < <(find "$STAGING" -type f -print0)

if [[ -n "$violations" ]]; then
  printf 'Publicação bloqueada por conteúdo privado:\n%s' "$violations" >&2
  exit 1
fi

if ! command -v surge >/dev/null 2>&1; then
  printf 'Erro: surge não foi encontrado no PATH. Instale com: npm i -g surge\n' >&2
  exit 1
fi

surge "$STAGING" "$DOMAIN"
printf 'Publicado em: https://%s\n' "$DOMAIN"
