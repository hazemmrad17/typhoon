"""
Connecteur de danger d'incendie via Open-Meteo Forecast API.

Calcule un indice de danger feu (proxy FWI) à partir des variables
météorologiques disponibles dans l'API principale :
- Température maximale
- Humidité minimale
- Vitesse du vent maximale
- Précipitations

Source : Open-Meteo Forecast API (gratuit, sans clé API)
  - Résolution : 1-11 km (modèle best_match)
  - Données : journalier, prévisions jusqu'à 16 jours
  - Historique : past_days jusqu'à 92 jours

API : https://open-meteo.com/en/docs
"""

from __future__ import annotations

import time
from typing import Any

import httpx

from app.core.logging import get_logger

logger = get_logger(__name__)

FORECAST_API_BASE = "https://api.open-meteo.com/v1/forecast"


def _compute_fire_danger_index(
    temp_max: float,
    rh_min: float,
    wind_max: float,
    precip: float,
) -> float:
    """Calcule un indice de danger feu simplifié (0-100).

    Basé sur les composantes du FWI canadien :
    - Température élevée → +
    - Humidité basse → +
    - Vent élevé → +
    - Précipitations récentes → -

    Retourne un indice 0-100 (0 = aucun danger, 100 = extrême).
    """
    # Score température (0-30) : max à 40°C+
    temp_score = max(0, min(30, (temp_max - 10) * 1.2))

    # Score humidité (0-30) : max quand humidity < 20%
    rh_score = max(0, min(30, (100 - rh_min) * 0.38))

    # Score vent (0-20) : max à 50 km/h+
    wind_score = max(0, min(20, wind_max * 0.4))

    # Score précipitations (réduction, -20 à 0) : forte pluie réduit le risque
    precip_penalty = max(-20, min(0, -precip * 2))

    raw = temp_score + rh_score + wind_score + precip_penalty
    return max(0, min(100, raw))


# Niveaux de danger FWI (système canadien, adaptés pour la France)
FWI_LEVELS = [
    {"max_fwi": 5, "level": "low", "label": "Faible", "color": "#3A7A6C"},
    {"max_fwi": 15, "level": "moderate", "label": "Modéré", "color": "#D4AC3E"},
    {"max_fwi": 30, "level": "high", "label": "Élevé", "color": "#D07030"},
    {"max_fwi": 50, "level": "very_high", "label": "Très élevé", "color": "#C04030"},
    {"max_fwi": 100, "level": "extreme", "label": "Extrême", "color": "#B03020"},
]


def _fwi_level(fwi: float) -> dict[str, str]:
    """Convertit une valeur FWI en niveau de danger."""
    for lvl in FWI_LEVELS:
        if fwi <= lvl["max_fwi"]:
            return {"level": lvl["level"], "label": lvl["label"], "color": lvl["color"]}
    return {"level": "extreme", "label": "Extrême", "color": "#B03020"}


async def fetch_fire_danger(lat: float, lon: float) -> dict[str, Any] | None:
    """Récupère le danger d'incendie pour une coordonnée.

    Utilise l'API forecast principale d'Open-Meteo avec les variables :
    - temperature_2m_max
    - relative_humidity_2m_min
    - wind_speed_10m_max
    - precipitation_sum

    Retourne un indice de danger feu calculé, les prévisions 7 jours,
    et les statistiques des 30 derniers jours.

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
                        "temperature_2m_max",
                        "relative_humidity_2m_min",
                        "wind_speed_10m_max",
                        "precipitation_sum",
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
        temp_max = daily.get("temperature_2m_max", [])
        rh_min = daily.get("relative_humidity_2m_min", [])
        wind_max = daily.get("wind_speed_10m_max", [])
        precip = daily.get("precipitation_sum", [])

        if not dates:
            logger.warning("fire_danger -- pas de données pour %.4f, %.4f", lat, lon)
            return None

        # Calculer l'indice de danger feu pour chaque jour
        fwi_values = []
        for i in range(len(dates)):
            t = temp_max[i] if i < len(temp_max) and temp_max[i] is not None else 20.0
            h = rh_min[i] if i < len(rh_min) and rh_min[i] is not None else 50.0
            w = wind_max[i] if i < len(wind_max) and wind_max[i] is not None else 10.0
            p = precip[i] if i < len(precip) and precip[i] is not None else 0.0
            fwi_values.append(_compute_fire_danger_index(t, h, w, p))

        if not fwi_values:
            return None

        # Séparer historique (365 jours) et prévision (16 jours)
        past_count = min(92, len(fwi_values))
        historical_fwi = fwi_values[:past_count]
        forecast_fwi = fwi_values[past_count:]

        # Indice actuel = jour le plus récent de l'historique
        current_fwi = historical_fwi[-1]
        risk = _fwi_level(current_fwi)

        # Statistiques historiques (92 derniers jours)
        avg_fwi = sum(historical_fwi) / len(historical_fwi) if historical_fwi else 0
        max_fwi = max(historical_fwi) if historical_fwi else 0

        # Prévisions (16 prochains jours)
        forecast = []
        for i, fwi in enumerate(forecast_fwi):
            idx = past_count + i
            if idx < len(dates):
                lvl = _fwi_level(fwi)
                forecast.append({
                    "date": dates[idx],
                    "fwi": round(fwi, 1),
                    "level": lvl["level"],
                    "label": lvl["label"],
                    "color": lvl["color"],
                })

        return {
            "current_fwi": round(current_fwi, 1),
            "risk_level": risk["level"],
            "risk_label": risk["label"],
            "risk_color": risk["color"],
            "avg_fwi_92d": round(avg_fwi, 1),
            "max_fwi_92d": round(max_fwi, 1),
            "forecast_16day": forecast,
            "source": "Open-Meteo Forecast API ~1-11km",
            "unit": "FWI",
        }

    except httpx.HTTPError as exc:
        logger.warning("fire_danger -- erreur HTTP pour %.4f, %.4f: %s", lat, lon, exc)
        return None
    except Exception as exc:
        logger.warning("fire_danger -- erreur inattendue pour %.4f, %.4f: %s", lat, lon, exc)
        return None
