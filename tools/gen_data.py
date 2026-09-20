#!/usr/bin/env python3
"""Build the static browser data bundle for the CSA dashboard."""

from __future__ import annotations

import json
import math
import re
import unicodedata
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from typing import Any, Iterable


DASHBOARD_DIR = Path(__file__).resolve().parent.parent
OBSERVATIONS_PATH = DASHBOARD_DIR / "data" / "raw" / "observations.json"
PHOTOS_DIR = DASHBOARD_DIR / "data" / "photos"
TALHOES_DIR = DASHBOARD_DIR / "talhoes"
OUTPUT_PATH = DASHBOARD_DIR / "data.js"
OBSERVATIONS_PREFIX = "Observations:"
PLOT_NAME_RE = re.compile(r"^A\d+", re.IGNORECASE)
BOUNDARY_NAME = "PERIMETRO DO SÍTIO"
PT_BR_MONTHS = {
    "jan": 1,
    "janeiro": 1,
    "fev": 2,
    "fevereiro": 2,
    "mar": 3,
    "marco": 3,
    "abr": 4,
    "abril": 4,
    "mai": 5,
    "maio": 5,
    "jun": 6,
    "junho": 6,
    "jul": 7,
    "julho": 7,
    "ago": 8,
    "agosto": 8,
    "set": 9,
    "setembro": 9,
    "out": 10,
    "outubro": 10,
    "nov": 11,
    "novembro": 11,
    "dez": 12,
    "dezembro": 12,
}


def read_observations(path: Path) -> list[dict[str, Any]]:
    raw = path.read_text(encoding="utf-8")
    stripped = raw.lstrip("\ufeff \t\r\n")
    if not stripped.startswith(OBSERVATIONS_PREFIX):
        raise ValueError(
            f"{path} não começa com o prefixo esperado {OBSERVATIONS_PREFIX!r}"
        )
    payload = json.loads(stripped[len(OBSERVATIONS_PREFIX) :].lstrip())
    data = payload.get("data")
    if not isinstance(data, list):
        raise ValueError(f"{path} não contém uma lista em 'data'")
    return [item for item in data if isinstance(item, dict)]


def finite_number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(str(value).strip().replace(",", "."))
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def parse_planting_date(raw: Any) -> date | None:
    if raw is None or not str(raw).strip():
        return None
    value = " ".join(str(raw).strip().split())

    full_date = re.fullmatch(r"(\d{2})/(\d{2})/(\d{4})", value)
    if full_date:
        day, month, year = (int(part) for part in full_date.groups())
        try:
            return date(year, month, day)
        except ValueError:
            return None

    month_year = re.fullmatch(r"(\d{1,2})/(\d{4})", value)
    if month_year:
        month, year = (int(part) for part in month_year.groups())
        try:
            return date(year, month, 15)
        except ValueError:
            return None

    named_month = re.fullmatch(r"([^/]+)/\s*(\d{4})", value)
    if not named_month:
        return None
    month_name = "".join(
        character
        for character in unicodedata.normalize("NFD", named_month.group(1))
        if unicodedata.category(character) != "Mn"
    ).lower().rstrip(".")
    month = PT_BR_MONTHS.get(month_name)
    if month is None:
        return None
    return date(int(named_month.group(2)), month, 15)


def parse_harvest_days(raw: Any) -> float | None:
    value = finite_number(raw)
    return value if value is not None and value >= 0 else None


def round_half_up_days(value: float) -> int:
    return int(Decimal(str(value)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def parseQuantity(raw: Any) -> dict[str, Any]:
    result = {
        "totalKg": None,
        "parts": None,
        "unit": None,
        "ambiguous": False,
        "raw": raw,
    }
    if raw is None or not str(raw).strip():
        return result

    parsed: list[tuple[Decimal, bool, bool]] = []
    ambiguous = False
    any_explicit_kg = False

    for part in str(raw).split("+"):
        stripped = part.strip()
        explicit_kg = re.search(r"kg\s*$", stripped, re.IGNORECASE) is not None
        explicit_decimal = "," in stripped or "." in stripped
        any_explicit_kg = any_explicit_kg or explicit_kg
        numeric = re.sub(r"(?:kg|g)\s*$", "", stripped, flags=re.IGNORECASE)
        numeric = re.sub(r"[^0-9.\-]", "", numeric.replace(",", "."))
        try:
            value = Decimal(numeric)
            if not value.is_finite():
                raise InvalidOperation
        except (InvalidOperation, ValueError):
            ambiguous = True
            continue
        parsed.append((value, explicit_kg, explicit_decimal))

    result["parts"] = len(parsed)
    result["ambiguous"] = ambiguous
    if not parsed:
        result["unit"] = "kg" if any_explicit_kg else None
        return result

    values = [value for value, _, _ in parsed]
    if any_explicit_kg:
        result["unit"] = "kg"
        total = sum(
            (
                value / Decimal(1000)
                if explicit_kg and value == value.to_integral_value() and abs(value) > 100
                else value
            )
            for value, explicit_kg, _ in parsed
        )
    elif any(explicit_decimal for _, _, explicit_decimal in parsed):
        result["unit"] = "kg"
        total = sum(values)
    elif len(values) == 1 and values[0] == values[0].to_integral_value() and values[0] <= 100:
        result["unit"] = "unidades"
        return result
    else:
        result["unit"] = "kg"
        result["ambiguous"] = True
        total = sum(values) / Decimal(1000)

    result["totalKg"] = float(total.quantize(Decimal("0.1"), rounding=ROUND_HALF_UP))
    return result


def valid_coordinates(observation: dict[str, Any]) -> tuple[float, float] | None:
    lat = finite_number(observation.get("lat"))
    lon = finite_number(observation.get("lon"))
    if lat is None or lon is None or lat == 0 or lon == 0:
        return None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    return lat, lon


def read_features() -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    plots: list[dict[str, Any]] = []
    boundary: dict[str, Any] | None = None

    for path in sorted(TALHOES_DIR.glob("Name_*.geojson")):
        collection = json.loads(path.read_text(encoding="utf-8"))
        for feature in collection.get("features", []):
            properties = feature.get("properties") or {}
            geometry = feature.get("geometry")
            name = str(properties.get("Name") or "").strip()
            if not geometry:
                continue
            if name == BOUNDARY_NAME:
                boundary = {
                    "type": "Feature",
                    "properties": {"name": name},
                    "geometry": geometry,
                }
            elif PLOT_NAME_RE.match(name):
                plots.append(
                    {
                        "name": name,
                        "areaHa": finite_number(properties.get("area_ha")),
                        "geometry": geometry,
                    }
                )

    plots.sort(key=plot_sort_key)
    return plots, boundary


def plot_sort_key(plot: dict[str, Any]) -> tuple[int, str]:
    match = re.match(r"^A(\d+)", plot["name"], re.IGNORECASE)
    return (int(match.group(1)) if match else 10_000, plot["name"])


def point_on_segment(
    x: float, y: float, x1: float, y1: float, x2: float, y2: float
) -> bool:
    epsilon = 1e-10
    cross = (x - x1) * (y2 - y1) - (y - y1) * (x2 - x1)
    if abs(cross) > epsilon:
        return False
    return (
        min(x1, x2) - epsilon <= x <= max(x1, x2) + epsilon
        and min(y1, y2) - epsilon <= y <= max(y1, y2) + epsilon
    )


def point_in_ring(lon: float, lat: float, ring: list[list[float]]) -> bool:
    inside = False
    if len(ring) < 3:
        return False

    previous = ring[-1]
    for current in ring:
        x1, y1 = float(previous[0]), float(previous[1])
        x2, y2 = float(current[0]), float(current[1])
        if point_on_segment(lon, lat, x1, y1, x2, y2):
            return True
        if (y1 > lat) != (y2 > lat):
            intersection_x = (x2 - x1) * (lat - y1) / (y2 - y1) + x1
            if lon < intersection_x:
                inside = not inside
        previous = current
    return inside


def point_in_polygon(lon: float, lat: float, rings: list[list[list[float]]]) -> bool:
    if not rings or not point_in_ring(lon, lat, rings[0]):
        return False
    return not any(point_in_ring(lon, lat, hole) for hole in rings[1:])


def point_in_geometry(lon: float, lat: float, geometry: dict[str, Any]) -> bool:
    coordinates = geometry.get("coordinates") or []
    if geometry.get("type") == "Polygon":
        return point_in_polygon(lon, lat, coordinates)
    if geometry.get("type") == "MultiPolygon":
        return any(point_in_polygon(lon, lat, polygon) for polygon in coordinates)
    return False


def first_nonempty(mapping: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        value = mapping.get(key)
        if value is not None and value != "":
            return value
    return None


def build_records(
    raw_observations: Iterable[dict[str, Any]],
    plots: list[dict[str, Any]],
    generation_date: date | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    generation_date = generation_date or datetime.now(timezone.utc).date()
    species: list[dict[str, Any]] = []
    observations: list[dict[str, Any]] = []
    located: list[dict[str, Any]] = []

    for observation in raw_observations:
        coords = valid_coordinates(observation)
        if coords is None:
            continue
        lat, lon = coords
        tags = observation.get("tags") or {}
        if not isinstance(tags, dict):
            tags = {}
        doc_id = str(observation.get("docId") or "")
        category_id = tags.get("categoryId")
        notes = first_nonempty(tags, "notes", "observacoes") or ""
        created_at = observation.get("createdAt")

        observations.append(
            {
                "docId": doc_id,
                "categoryId": category_id,
                "notes": notes,
                "lat": lat,
                "lon": lon,
                "createdAt": created_at,
            }
        )
        located.append({"lat": lat, "lon": lon, "tags": tags})

        species_name = tags.get("qual-especie")
        if species_name is None or not str(species_name).strip():
            continue

        photo_name = f"{doc_id[:12]}_0.jpg"
        photo = f"data/photos/{photo_name}" if (PHOTOS_DIR / photo_name).is_file() else None
        metadata = observation.get("metadata") or {}
        position = metadata.get("position") or {}
        accuracy = (position.get("coords") or {}).get("accuracy")
        talhao_original = tags.get("talhao")
        talhao = next(
            (
                plot["name"]
                for plot in plots
                if point_in_geometry(lon, lat, plot["geometry"])
            ),
            talhao_original,
        )
        quantity = tags.get("quantity")
        parsed_quantity = parseQuantity(quantity)
        planting_date_raw_value = tags.get("data-de-plantio")
        planting_date_raw = (
            str(planting_date_raw_value)
            if planting_date_raw_value is not None
            and str(planting_date_raw_value).strip()
            else None
        )
        planting_date = parse_planting_date(planting_date_raw)
        harvest_days = parse_harvest_days(tags.get("tempo-de-colheita"))
        projected_harvest = (
            planting_date + timedelta(days=round_half_up_days(harvest_days))
            if planting_date is not None and harvest_days is not None
            else None
        )
        management_status = tags.get("management-status")
        projection_active = (
            projected_harvest is not None
            and projected_harvest > generation_date
            and management_status != "colhida"
        )
        cycle_fulfilled = (
            projected_harvest is not None
            and projected_harvest <= generation_date
            and management_status == "colhida"
        )

        species.append(
            {
                "docId": doc_id,
                "name": str(species_name).strip(),
                "categoryId": category_id,
                "talhao": talhao,
                "talhaoOriginal": talhao_original,
                "productionStatus": tags.get("production-status"),
                "developmentStatus": tags.get("development-status"),
                "healthStatus": tags.get("health-status"),
                "managementStatus": management_status,
                "plantingDate": planting_date.isoformat() if planting_date else None,
                "plantingDateRaw": planting_date_raw,
                "harvestDays": harvest_days,
                "projectedHarvest": (
                    projected_harvest.isoformat() if projected_harvest else None
                ),
                "projectionSource": "registro" if projected_harvest else None,
                "projectionActive": projection_active,
                "cycleFulfilled": cycle_fulfilled,
                "quantity": quantity,
                "quantityKg": parsed_quantity["totalKg"],
                "quantityParts": parsed_quantity["parts"],
                "quantityUnit": parsed_quantity["unit"],
                "quantityAmbiguous": parsed_quantity["ambiguous"],
                "mainUse": tags.get("main-use"),
                "notes": notes,
                "lat": lat,
                "lon": lon,
                "createdAt": created_at,
                "accuracy": finite_number(accuracy),
                "photo": photo,
            }
        )

    return species, observations, located


def mean(values: list[float]) -> float | None:
    return round(sum(values) / len(values), 2) if values else None


def normalized_qualitative(value: Any) -> str | None:
    if value is None:
        return None
    normalized = " ".join(str(value).split())
    if not normalized or finite_number(normalized) is not None:
        return None
    return normalized.lower().capitalize()


def build_soil(
    plots: list[dict[str, Any]], located: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for plot in plots:
        contained = [
            item
            for item in located
            if point_in_geometry(item["lon"], item["lat"], plot["geometry"])
        ]
        ph_values = [
            value
            for item in contained
            if (value := finite_number(item["tags"].get("ph-do-solo"))) is not None
        ]
        temp_values = [
            value
            for item in contained
            if (value := finite_number(item["tags"].get("temperatura"))) is not None
        ]
        moist_values = [
            value
            for item in contained
            if (value := finite_number(item["tags"].get("umidade"))) is not None
        ]
        moist_labels = [
            value
            for item in contained
            if (value := normalized_qualitative(item["tags"].get("umidade")))
            is not None
        ]
        moist_mode = Counter(moist_labels).most_common(1)[0][0] if moist_labels else None
        result.append(
            {
                "talhao": plot["name"],
                "n": len(contained),
                "phAvg": mean(ph_values),
                "tempAvg": mean(temp_values),
                "moistAvg": mean(moist_values),
                "moistMode": moist_mode,
            }
        )
    return result


def main() -> None:
    generated_at = datetime.now(timezone.utc)
    raw_observations = read_observations(OBSERVATIONS_PATH)
    plots, boundary = read_features()
    if boundary is None:
        raise ValueError(f"Talhão de perímetro {BOUNDARY_NAME!r} não encontrado")

    species, observations, located = build_records(
        raw_observations, plots, generated_at.date()
    )
    soil = build_soil(plots, located)
    payload = {
        "generatedAt": generated_at.isoformat().replace("+00:00", "Z"),
        "species": species,
        "observations": observations,
        "talhoes": plots,
        "boundary": boundary,
        "soil": soil,
    }
    serialized = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    OUTPUT_PATH.write_text(f"window.CSA_DATA = {serialized};\n", encoding="utf-8")

    soil_with_values = sum(
        1
        for item in soil
        if any(
            item[key] is not None
            for key in ("phAvg", "tempAvg", "moistAvg", "moistMode")
        )
    )
    print(f"Espécies: {len(species)}")
    print(f"Observações com coordenadas válidas: {len(observations)}")
    print(f"Talhões: {len(plots)}")
    print(f"Perímetro: {'sim' if boundary else 'não'}")
    print(f"Talhões com dados de solo: {soil_with_values}/{len(soil)}")
    print(
        "Projeções ativas: "
        + str(sum(1 for item in species if item["projectionActive"]))
    )
    print(
        "Ciclos cumpridos: "
        + str(sum(1 for item in species if item["cycleFulfilled"]))
    )
    print(f"Arquivo gerado: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
