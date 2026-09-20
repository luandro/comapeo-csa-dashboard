#!/usr/bin/env bash
# PRIVACIDADE: .env, data/, talhoes/*.geojson e data.js são ignorados pelo Git.
# Esses arquivos contêm credenciais ou dados privados da fazenda e nunca devem
# ser adicionados ao repositório público.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
ENV_FILE="$REPO_ROOT/.env"
SERVER_OVERRIDE=""
TOKEN_OVERRIDE=""
PROJECT_OVERRIDE=""
SKIP_ZIP=0

usage() {
  cat <<'EOF'
Uso: scripts/fetch-data.sh [opções]

Baixa observações e miniaturas do CoMapeo Cloud e regenera data.js.

Opções:
  -s, --server-url URL       Sobrescreve SERVER_URL
  -t, --server-token TOKEN   Sobrescreve SERVER_BEARER_TOKEN
  -p, --project-id ID        Sobrescreve PROJECT_ID
  -z, --no-zip               Não mescla exports do app CoMapeo (.zip)
  -h, --help                 Mostra esta ajuda

Por padrão, as credenciais são lidas de .env na raiz do repositório.
EOF
}

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
    -s|--server-url)
      require_option_value "$1" "${2:-}"
      SERVER_OVERRIDE="$2"
      shift 2
      ;;
    -t|--server-token)
      require_option_value "$1" "${2:-}"
      TOKEN_OVERRIDE="$2"
      shift 2
      ;;
    -p|--project-id)
      require_option_value "$1" "${2:-}"
      PROJECT_OVERRIDE="$2"
      shift 2
      ;;
    -z|--no-zip)
      SKIP_ZIP=1
      shift
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

if ! command -v comapeo-cloud >/dev/null 2>&1; then
  printf 'Erro: comapeo-cloud não foi encontrado no PATH. Instale com: npm i -g comapeo-cloud-cli\n' >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  printf 'Erro: python3 não foi encontrado no PATH.\n' >&2
  exit 1
fi

cd "$REPO_ROOT"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

SERVER_URL="${SERVER_URL:-}"
SERVER_BEARER_TOKEN="${SERVER_BEARER_TOKEN:-}"
PROJECT_ID="${PROJECT_ID:-}"

CLI=(comapeo-cloud)
if [[ -n "$SERVER_OVERRIDE" ]]; then
  SERVER_URL="$SERVER_OVERRIDE"
  CLI+=(-s "$SERVER_OVERRIDE")
fi
if [[ -n "$TOKEN_OVERRIDE" ]]; then
  SERVER_BEARER_TOKEN="$TOKEN_OVERRIDE"
  CLI+=(-t "$TOKEN_OVERRIDE")
fi
if [[ -n "$PROJECT_OVERRIDE" ]]; then
  PROJECT_ID="$PROJECT_OVERRIDE"
fi

if [[ -z "$SERVER_URL" || -z "$SERVER_BEARER_TOKEN" ]]; then
  printf 'Erro: configure SERVER_URL e SERVER_BEARER_TOKEN em .env ou use -s e -t.\n' >&2
  exit 1
fi

if [[ -z "$PROJECT_ID" ]]; then
  printf 'Consultando projetos disponíveis…\n'
  PROJECTS_OUTPUT="$("${CLI[@]}" list-projects)"
  if ! PROJECT_ROWS_OUTPUT="$({ PROJECTS_RAW="$PROJECTS_OUTPUT" python3 - <<'PY'
import json
import os

raw = os.environ.get("PROJECTS_RAW", "")
starts = [position for marker in ("{", "[") if (position := raw.find(marker)) >= 0]
if not starts:
    raise SystemExit(1)
payload = json.loads(raw[min(starts):])
projects = payload.get("data", []) if isinstance(payload, dict) else payload
if not isinstance(projects, list):
    raise SystemExit(1)
for project in projects:
    if not isinstance(project, dict):
        continue
    project_id = project.get("projectId") or project.get("$projectId") or project.get("publicId") or project.get("id")
    if not project_id:
        continue
    name = project.get("name") or project.get("projectName") or project.get("displayName") or "Sem nome"
    clean_name = " ".join(str(name).split())
    print(f"{project_id}\t{clean_name}")
PY
  } 2>/dev/null)"; then
    printf 'Erro: não foi possível interpretar a lista de projetos retornada pelo servidor.\n' >&2
    exit 1
  fi

  PROJECT_ROWS=()
  if [[ -n "$PROJECT_ROWS_OUTPUT" ]]; then
    mapfile -t PROJECT_ROWS <<< "$PROJECT_ROWS_OUTPUT"
  fi
  if ((${#PROJECT_ROWS[@]} == 1)); then
    PROJECT_ID="${PROJECT_ROWS[0]%%$'\t'*}"
  else
    printf 'Projetos disponíveis:\n' >&2
    for row in "${PROJECT_ROWS[@]}"; do
      project_id="${row%%$'\t'*}"
      project_name="${row#*$'\t'}"
      printf '  %s — %s\n' "$project_name" "$project_id" >&2
    done
    printf 'Defina PROJECT_ID ou use -p para escolher um projeto.\n' >&2
    exit 2
  fi
fi

if ! compgen -G 'talhoes/Name_*.geojson' >/dev/null; then
  printf 'Erro: nenhum talhão privado foi encontrado em talhoes/. Consulte talhoes/README.md.\n' >&2
  exit 1
fi

mkdir -p data/raw data/photos

printf 'Baixando observações…\n'
"${CLI[@]}" list-observations -p "$PROJECT_ID" > data/raw/observations.json

if ! ATTACHMENT_ROWS="$(python3 - data/raw/observations.json <<'PY'
import json
import sys
from pathlib import Path

raw = Path(sys.argv[1]).read_text(encoding="utf-8").lstrip("\ufeff \t\r\n")
prefix = "Observations:"
if not raw.startswith(prefix):
    raise SystemExit("arquivo de observações sem o prefixo esperado")
payload = json.loads(raw[len(prefix):].lstrip())
observations = payload.get("data", [])
if not isinstance(observations, list):
    raise SystemExit("resposta sem lista de observações")
for observation in observations:
    if not isinstance(observation, dict):
        continue
    tags = observation.get("tags") or {}
    if not isinstance(tags, dict) or not str(tags.get("qual-especie") or "").strip():
        continue
    doc_id = str(observation.get("docId") or "")[:12]
    if not doc_id:
        continue
    attachments = observation.get("attachments") or []
    if not isinstance(attachments, list):
        continue
    for index, attachment in enumerate(attachments):
        if not isinstance(attachment, dict) or not attachment.get("url"):
            continue
        print(f"{doc_id}\t{index}\t{attachment['url']}")
PY
)"; then
  printf 'Erro: não foi possível interpretar as observações baixadas.\n' >&2
  exit 1
fi

PHOTO_COUNT=0
if [[ -n "$ATTACHMENT_ROWS" ]]; then
  printf 'Baixando miniaturas…\n'
  while IFS=$'\t' read -r doc_prefix attachment_index attachment_url; do
    output="data/photos/${doc_prefix}_${attachment_index}.jpg"
    if ! "${CLI[@]}" get-attachment -u "$attachment_url" --variant thumbnail -o "$output" >/dev/null 2>&1; then
      printf 'Erro: falha ao baixar uma miniatura; nenhuma credencial foi exibida.\n' >&2
      exit 1
    fi
    ((PHOTO_COUNT += 1))
  done <<< "$ATTACHMENT_ROWS"
fi

ZIP_MERGED=0
ZIP_THUMBS=0
if [[ "$SKIP_ZIP" -eq 0 ]]; then
  printf 'Verificando exports do app CoMapeo (.zip)…\n'
  ZIPS=()
  while IFS= read -r -d '' zipfile; do
    ZIPS+=("$zipfile")
  done < <(find "$REPO_ROOT" -maxdepth 1 -name 'CoMapeo_*.zip' -print0 | sort -z)
  if ((${#ZIPS[@]} == 0)); then
    printf '  Nenhum export encontrado.\n'
  else
    for zipfile in "${ZIPS[@]}"; do
      printf '  Mesclando %s…\n' "$(basename "$zipfile")"
    done
    if ! MERGE_ROWS="$(python3 - data/raw/observations.json data/photos "${ZIPS[@]}" <<'PY'
import io
import json
import sys
import zipfile
from pathlib import Path

obs_path = Path(sys.argv[1])
photos_dir = Path(sys.argv[2])
zip_paths = sys.argv[3:]

PREFIX = "Observations:"
raw = obs_path.read_text(encoding="utf-8").lstrip("﻿ \t\r\n")
if not raw.startswith(PREFIX):
    raise SystemExit("arquivo de observacoes sem o prefixo esperado")
payload = json.loads(raw[len(PREFIX):].lstrip())
observations = payload.get("data", [])
if not isinstance(observations, list):
    raise SystemExit("resposta sem lista de observacoes")

known = {o.get("docId") for o in observations if isinstance(o, dict)}
merged = 0
invalid = 0
thumbs = 0

def make_thumb(data, target):
    from PIL import Image
    with Image.open(io.BytesIO(data)) as image:
        image = image.convert("RGB")
        image.thumbnail((320, 320))
        image.save(target, "JPEG", quality=75)

for zip_path in zip_paths:
    with zipfile.ZipFile(zip_path) as zf:
        geo_name = next((n for n in zf.namelist() if n.endswith(".geojson")), None)
        if not geo_name:
            continue
        try:
            features = json.loads(zf.read(geo_name)).get("features", [])
        except (ValueError, KeyError):
            continue
        by_name = {n.rsplit("/", 1)[-1]: n for n in zf.namelist() if "_Media_" in n}
        for feature in features:
            if not isinstance(feature, dict):
                continue
            core = feature.get("$comapeo")
            props = feature.get("properties") or {}
            doc_id = (core or {}).get("docId") or props.get("$id")
            if not isinstance(core, dict) or core.get("schemaName") != "observation":
                invalid += 1
                continue
            if not doc_id or doc_id in known:
                continue
            lat, lon = core.get("lat"), core.get("lon")
            tags = core.get("tags")
            if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)) or lat == 0 or lon == 0:
                invalid += 1
                continue
            if not isinstance(tags, dict):
                invalid += 1
                continue
            record = dict(core)
            record["docId"] = doc_id
            record["source"] = "zip-export"
            observations.append(record)
            known.add(doc_id)
            merged += 1
            for index, attachment in enumerate(record.get("attachments") or []):
                if not isinstance(attachment, dict) or attachment.get("type") != "photo":
                    continue
                name = str(attachment.get("name") or "")
                member = next((v for k, v in by_name.items() if k.startswith(name + "_original.")), None)
                if not member:
                    continue
                target = photos_dir / f"{doc_id[:12]}_{index}.jpg"
                if target.exists():
                    continue
                try:
                    make_thumb(zf.read(member), target)
                    thumbs += 1
                except Exception:
                    continue

obs_path.write_text(PREFIX + "\n" + json.dumps({"data": observations}, ensure_ascii=False), encoding="utf-8")
print(f"{merged}\t{thumbs}\t{invalid}")
PY
)"; then
      printf 'Erro: nao foi possivel mesclar os exports .zip (formato incompativel).\n' >&2
      exit 1
    fi
    IFS=$'\t' read -r ZIP_MERGED ZIP_THUMBS ZIP_INVALID <<< "$MERGE_ROWS"
    printf '  Mesclados do export: %s (invalidos ignorados: %s, miniaturas: %s)\n' "$ZIP_MERGED" "$ZIP_INVALID" "$ZIP_THUMBS"
  fi
fi

python3 tools/gen_data.py

if ! COUNTS="$(python3 - data/raw/observations.json <<'PY'
import json
import sys
from pathlib import Path

raw = Path(sys.argv[1]).read_text(encoding="utf-8").lstrip("\ufeff \t\r\n")
payload = json.loads(raw[len("Observations:"):].lstrip())
observations = payload.get("data", [])
species = sum(
    1
    for observation in observations
    if isinstance(observation, dict)
    and isinstance(observation.get("tags"), dict)
    and str(observation["tags"].get("qual-especie") or "").strip()
)
print(f"{len(observations)}\t{species}")
PY
)"; then
  printf 'Erro: não foi possível calcular o resumo final.\n' >&2
  exit 1
fi

IFS=$'\t' read -r OBSERVATION_COUNT SPECIES_COUNT <<< "$COUNTS"
DATA_SIZE="$(wc -c < data.js)"
DATA_SIZE="${DATA_SIZE//[[:space:]]/}"

printf '\nResumo final:\n'
printf '  Observações: %s\n' "$OBSERVATION_COUNT"
printf '  Espécies: %s\n' "$SPECIES_COUNT"
printf '  Fotos: %s\n' "$PHOTO_COUNT"
printf '  data.js: %s bytes\n' "$DATA_SIZE"
