"""
Connecteur d'humidité du sol via Open-Meteo Forecast API.

Fournit l'humidité du sol pour la surveillance du risque argile/subsidence.
Utilise les variables soil_moisture de l'API forecast principale.

Source : Open-Meteo Forecast API (gratuit, sans clé API)
  - Résolution : 1-11 km (modèle best_match)
  - Variables : soil_moisture_0_to_7cm_mean, soil_moisture_7_to_28cm_mean
  - Données : journalier, historique jusqu'à 92 jours

API : https://open-meteo.com/en/docs
"""

from __future__ import annotations

import time
from typing import Any

import httpx

from app.core.logging import get_logger

logger = get_logger(__name__)

FORECAST_API_BASE = "https://api.open-meteo.com/v1/forecast"

# Seuils d'humidité du sol (m³/m³) pour le risque argile
# ERA5-Land : 0 = très sec, 0.5 = très humide
# La zone critique pour le retrait-gonflement des argiles est < 0.10 m³/m³
SOIL_THRESHOLDS = {
    "critical": 0.08,   # < 0.08 m³/m³ = risque critique de retrait-gonflement
    "high": 0.12,       # < 0.12 m³/m³ = risque élevé
    "moderate": 0.18,   # < 0.18 m³/m³ = risque modéré
    "low": 1.0,         # > 0.18 m³/m³ = faible
}


def _soil_level(value: float) -> dict[str, str]:
    """Convertit une valeur d'humidité du sol en niveau de risque."""
    if value < SOIL_THRESHOLDS["critical"]:
        return {"level": "critical", "label": "Critique", "color": "#B03020"}
    if value < SOIL_THRESHOLDS["high"]:
        return {"level": "high", "label": "Élevé", "color": "#D07030"}
    if value < SOIL_THRESHOLDS["moderate"]:
        return {"level": "moderate", "label": "Modéré", "color": "#D4AC3E"}
    return {"level": "low", "label": "Faible", "color": "#3A7A6C"}


async def fetch_soil_moisture(lat: float, lon: float) -> dict[str, Any] | None:
    """Récupère l'humidité du sol pour une coordonnée.

    Utilise l'API forecast principale d'Open-Meteo avec les variables :
    - soil_moisture_0_to_7cm_mean (surface)
    - soil_moisture_7_to_28cm_mean (profondeur)

    Retourne :
    - current_value : humidité actuelle (m³/m³)
    - unit : m³/m³
    - status : critical/high/moderate/low
    - monthly_series : 30 derniers jours
    - source : identifiant de la source

    Retourne None si l'API est indisponible.
    """
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.get(
                FORECAST_API_BASE,
                params={
                    "latitude": lat,
                    "longitude": lon,
                    "daily": ",".join([
                        "soil_moisture_0_to_7cm_mean",
                        "soil_moisture_7_to_28cm_mean",
                    ]),
                    "past_days": 92,
                    "forecast_days": 16,
                    "timezone": "auto",
                },
            )
            resp.raise_for_status()
            data = resp.json()

        daily = data.get("daily", {})
        dates = daily.get("time", [])
        surface = daily.get("soil_moisture_0_to_7cm_mean", [])
        depth = daily.get("soil_moisture_7_to_28cm_mean", [])

        if not dates:
            logger.warning("soil_moisture -- pas de données pour %.4f, %.4f", lat, lon)
            return None

        # Humidité actuelle = surface (couche la plus pertinente pour l'argile)
        current_values = [v for v in surface if v is not None]
        if not current_values:
            # Fallback sur la couche profonde
            current_values = [v for v in depth if v is not None]
        if not current_values:
            return None

        current_value = current_values[-1]
        level = _soil_level(current_value)

        # Statistiques des 365 jours
        avg_value = sum(current_values) / len(current_values) if current_values else 0
        min_value = min(current_values) if current_values else 0
        max_value = max(current_values) if current_values else 0

        # Série historique (365 derniers jours)
        monthly_series = []
        for i in range(len(dates)):
            val = surface[i] if i < len(surface) else None
            if val is None:
                val = depth[i] if i < len(depth) else None
            if val is not None:
                monthly_series.append({
                    "date": dates[i],
                    "value": round(val, 4),
                    "unit": "m³/m³",
                })

        return {
            "current_value": round(current_value, 4),
            "unit": "m³/m³",
            "status": level["level"],
            "risk_label": level["label"],
            "risk_color": level["color"],
            "avg_value_30d": round(avg_value, 4),
            "min_value_30d": round(min_value, 4),
            "max_value_30d": round(max_value, 4),
            "monthly_series": monthly_series,
            "source": "Open-Meteo Forecast API ~1-11km",
        }

    except httpx.HTTPError as exc:
        logger.warning("soil_moisture -- erreur HTTP pour %.4f, %.4f: %s", lat, lon, exc)
        return None
    except Exception as exc:
        logger.warning("soil_moisture -- erreur inattendue pour %.4f, %.4f: %s", lat, lon, exc)
        return None


# ---------------------------------------------------------------------------
# Legacy functions (kept for backward compatibility with old tests/plots)
# ---------------------------------------------------------------------------

async def fetch_temperature_anomaly(lat: float, lon: float) -> dict[str, Any] | None:
    """Placeholder — non utilisé dans le dashboard opérationnel."""
    return None


async def fetch_precipitation_anomaly(lat: float, lon: float) -> dict[str, Any] | None:
    """Placeholder — non utilisé dans le dashboard opérationnel."""
    return None
