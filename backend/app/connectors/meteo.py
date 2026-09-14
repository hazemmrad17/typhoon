"""Référence météo/hydrologique réelle (Open-Meteo) — opposable à l'enveloppe.

Le produit distingue désormais trois natures de faits, et ne les confond
jamais :

  · géographie RÉELLE    — le trajet de l'eau (IGN BD TOPO, cf. hydro.py) ;
  · référence RÉELLE     — la pluie prévue et le débit de rivière estimé,
                           qui vivent ici ;
  · enveloppe MODÉLISÉE  — les dommages du scénario (damageModel.ts), qui ne
                           sont pas une mesure et ne sont jamais présentés
                           comme telle.

Sources (sans clé, CORS ouvert, vérifiées en direct) :
  · `api.open-meteo.com/v1/forecast` — cumuls horaires `precipitation` / `rain`.
  · `flood-api.open-meteo.com/v1/flood` — `river_discharge` (GloFAS) quotidien,
    avec sa moyenne et son maximum d'ensemble.

Règle de contrat : aucun échec réseau ne casse l'UI. Toute erreur renvoie un
résultat typé « indisponible » avec sa raison ; le frontend retombe alors sur
l'enveloppe de scénario, clairement étiquetée.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import httpx

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
FLOOD_URL = "https://flood-api.open-meteo.com/v1/flood"

SOURCE_FORECAST = "Open-Meteo (prévision horaire)"
SOURCE_DISCHARGE = "Open-Meteo Flood / GloFAS v4 (débit estimé)"

TIMEOUT_S = 12.0

# Seuil sous lequel on considère qu'il n'y a « rien à voir » : en dessous, on
# l'affiche explicitement plutôt que de dessiner une courbe plate trompeuse.
DRY_TOTAL_MM = 0.2


async def _get_json(client: httpx.AsyncClient, url: str, params: dict[str, str]) -> dict[str, Any] | None:
    for _ in range(2):
        try:
            resp = await client.get(url, params=params, timeout=TIMEOUT_S)
            if resp.status_code != 200:
                continue
            data = resp.json()
            if isinstance(data, dict) and "error" not in data:
                return data
            return None
        except (httpx.HTTPError, httpx.TimeoutException, ValueError):
            continue
    return None


def _pair(time_axis: list[Any], values: list[Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for i, t in enumerate(time_axis or []):
        v = values[i] if values and i < len(values) else None
        out.append({"t": t, "v": v})
    return out


async def fetch_meteo(lat: float, lon: float) -> dict[str, Any]:
    """Pluie horaire prévue + débit de rivière estimé pour un point.

    Ne lève jamais.
    """
    out: dict[str, Any] = {
        "lat": lat,
        "lon": lon,
        "rain_hourly": [],
        "rain_total_mm": None,
        "rain_peak_mm_h": None,
        "dry": None,
        "wind_gusts_hourly": [],
        "wind_speed_hourly": [],
        "wind_gust_peak_kmh": None,
        "wind_gust_peak_time": None,
        "wind_gust_peak_dir_deg": None,
        "soil_moisture_hourly": [],
        "soil_moisture_min": None,
        "soil_moisture_max": None,
        "discharge": None,
        "sources": {"rain": SOURCE_FORECAST, "discharge": SOURCE_DISCHARGE},
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
        "unavailable_reason": None,
        "unavailable_label": None,
    }

    reasons: list[str] = []
    try:
        async with httpx.AsyncClient(follow_redirects=True) as client:
            forecast = await _get_json(
                client,
                FORECAST_URL,
                {
                    "latitude": f"{lat:.5f}",
                    "longitude": f"{lon:.5f}",
                    "hourly": (
                        "precipitation,rain,wind_speed_10m,wind_gusts_10m,"
                        "wind_direction_10m,soil_moisture_0_to_7cm"
                    ),
                    "past_days": "1",
                    "forecast_days": "3",
                    "timezone": "Europe/Paris",
                },
            )
            if forecast:
                hourly = forecast.get("hourly") or {}
                axis = hourly.get("time") or []
                precip = hourly.get("precipitation") or []
                out["rain_hourly"] = _pair(axis, precip)
                vals = [v for v in precip if isinstance(v, (int, float))]
                if vals:
                    total = float(sum(vals))
                    out["rain_total_mm"] = round(total, 2)
                    out["rain_peak_mm_h"] = round(float(max(vals)), 2)
                    out["dry"] = total < DRY_TOTAL_MM

                # Vent / rafales horaires RÉELS (km/h) — même axe temporel que
                # la pluie ; le pic de rafales est la référence du risque vent.
                # Champs absents de la réponse → séries vides (jamais un axe
                # découplé rempli de None) : le frontend n'affiche alors pas
                # de simulation vent.
                gusts = hourly.get("wind_gusts_10m") or []
                speeds = hourly.get("wind_speed_10m") or []
                if gusts:
                    out["wind_gusts_hourly"] = _pair(axis, gusts)
                    out["wind_speed_hourly"] = _pair(axis, speeds)
                gvals = [v for v in gusts if isinstance(v, (int, float))]
                if gvals:
                    out["wind_gust_peak_kmh"] = round(float(max(gvals)), 1)
                    gi = max(range(len(gusts)), key=lambda i: gvals[i])
                    out["wind_gust_peak_time"] = axis[gi] if gi < len(axis) else None
                    # Direction du vent (°, provenance) à l'heure du pic —
                    # pilote l'orientation du cône d'exposition feu.
                    if gi < len(axis):
                        wdir = hourly.get("wind_direction_10m") or []
                        if gi < len(wdir) and isinstance(wdir[gi], (int, float)):
                            out["wind_gust_peak_dir_deg"] = wdir[gi]

                # Humidité du sol (m³/m³, couche 0–7 cm) — série réelle pour la
                # chronique de dessiccation RGA (retrait-gonflement des argiles).
                sm = hourly.get("soil_moisture_0_to_7cm") or []
                if sm:
                    out["soil_moisture_hourly"] = _pair(axis, sm)
                    svals = [v for v in sm if isinstance(v, (int, float))]
                    if svals:
                        out["soil_moisture_min"] = round(float(min(svals)), 4)
                        out["soil_moisture_max"] = round(float(max(svals)), 4)
            else:
                reasons.append("pluie prévue indisponible")

            flood = await _get_json(
                client,
                FLOOD_URL,
                {
                    "latitude": f"{lat:.5f}",
                    "longitude": f"{lon:.5f}",
                    "daily": "river_discharge,river_discharge_mean,river_discharge_max",
                    "forecast_days": "7",
                    "timezone": "Europe/Paris",
                },
            )
            if flood:
                daily = flood.get("daily") or {}
                axis = daily.get("time") or []
                series = daily.get("river_discharge") or []
                mean = daily.get("river_discharge_mean") or []
                maximum = daily.get("river_discharge_max") or []
                pairs = _pair(axis, series)
                current = next((p["v"] for p in pairs if isinstance(p["v"], (int, float))), None)
                peak = None
                peak_date = None
                for i, v in enumerate(maximum):
                    if isinstance(v, (int, float)) and (peak is None or v > peak):
                        peak = float(v)
                        peak_date = axis[i] if i < len(axis) else None
                out["discharge"] = {
                    "unit": (flood.get("daily_units") or {}).get("river_discharge", "m³/s"),
                    "series": pairs,
                    "mean": mean,
                    "max": maximum,
                    "current": current,
                    "peak": peak,
                    "peak_date": peak_date,
                    "elevation_m": flood.get("elevation"),
                }
            else:
                reasons.append("débit de rivière indisponible")
    except Exception as exc:  # noqa: BLE001 — contrat « ne casse jamais l'UI »
        reasons.append(f"service indisponible ({type(exc).__name__})")

    if reasons:
        out["unavailable_reason"] = "partial" if (out["rain_hourly"] or out["discharge"]) else "unavailable"
        out["unavailable_label"] = " ; ".join(reasons)
    return out
