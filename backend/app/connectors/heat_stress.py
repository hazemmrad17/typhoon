"""
Connecteur de stress thermique via Open-Meteo Forecast API.

Calcule l'indice de chaleur (heat index) à partir de la température
maximale et de l'humidité minimale. Utilisé pour évaluer le risque
de canicule et son impact sur les bâtiments (climatisation, dégradation
toiture, santé des occupants).

Indice de chaleur (Steadman, 1979) :
- < 27°C  : confort
- 27-32°C : attention
- 32-40°C : danger
- > 40°C  : danger extrême

Source : Open-Meteo Forecast API (gratuit, sans clé API)
  - Résolution : 1-11 km (modèle best_match)
  - Variables : temperature_2m_max, relative_humidity_2m_min
  - Données : journalier, historique jusqu'à 92 jours

API : https://open-meteo.com/en/docs
"""

from __future__ import annotations

import math
from typing import Any

import httpx

from app.core.logging import get_logger

logger = get_logger(__name__)

FORECAST_API_BASE = "https://api.open-meteo.com/v1/forecast"


def _heat_index(temp_c: float, rh: float) -> float:
    """Calcule l'indice de chaleur en °C (Steadman 1979, ajusté Rothfusz).

    Args:
        temp_c: température en °C
        rh: humidité relative en %

    Returns:
        Indice de chaleur en °C
    """
    if temp_c < 27:
        return temp_c

    # Formule simplifiée de Rothfusz (NWS)
    hi = (
        -8.7847
        + 1.6114 * temp_c
        + 2.3385 * rh
        - 0.1461 * temp_c * rh
        - 0.0068 * temp_c**2
        - 0.0548 * rh**2
        + 0.0012 * temp_c**2 * rh
        + 0.0008 * temp_c * rh**2
        - 0.000002 * temp_c**2 * rh**2
    )
    return max(temp_c, hi)


def _heat_level(hi: float) -> dict[str, str]:
    """Convertit un indice de chaleur en niveau de risque."""
    if hi >= 40:
        return {"level": "extreme", "label": "Danger extrême", "color": "#B03020"}
    if hi >= 32:
        return {"level": "high", "label": "Danger", "color": "#C04030"}
    if hi >= 27:
        return {"level": "moderate", "label": "Attention", "color": "#D07030"}
    if hi >= 22:
        return {"level": "low", "label": "Confort", "color": "#D4AC3E"}
    return {"level": "very_low", "label": "Frais", "color": "#3A7A6C"}


async def fetch_heat_stress(lat: float, lon: float) -> dict[str, Any] | None:
    """Récupère les données de stress thermique pour une coordonnée.

    Retourne :
    - current_hi : indice de chaleur actuel (°C)
    - current_temp : température maximale (°C)
    - current_rh : humidité minimale (%)
    - risk_level : niveau de risque
    - forecast_7day : prévisions 7 jours
    - max_hi_30d : max indice chaleur sur 30 jours
    - hot_days_30d : nombre de jours > 32°C sur 30 jours
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
                        "temperature_2m_max",
                        "relative_humidity_2m_min",
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

        if not dates:
            logger.warning("heat_stress -- pas de données pour %.4f, %.4f", lat, lon)
            return None

        # Calculer l'indice de chaleur pour chaque jour
        hi_values = []
        for i in range(len(dates)):
            t = temp_max[i] if i < len(temp_max) and temp_max[i] is not None else 20.0
            h = rh_min[i] if i < len(rh_min) and rh_min[i] is not None else 50.0
            hi_values.append(_heat_index(t, h))

        if not hi_values:
            return None

        # Séparer historique (92 jours max) et prévision (16 jours)
        past_count = min(92, len(hi_values))
        historical_hi = hi_values[:past_count]
        forecast_hi = hi_values[past_count:]

        # Indice actuel = dernier jour de l'historique
        current_hi = historical_hi[-1]
        current_temp = temp_max[past_count - 1] if past_count - 1 < len(temp_max) and temp_max[past_count - 1] is not None else 20.0
        current_rh = rh_min[past_count - 1] if past_count - 1 < len(rh_min) and rh_min[past_count - 1] is not None else 50.0
        risk = _heat_level(current_hi)

        # Statistiques historiques (92 jours)
        max_hi = max(historical_hi) if historical_hi else 0
        avg_hi = sum(historical_hi) / len(historical_hi) if historical_hi else 0
        hot_days = sum(1 for h in historical_hi if h >= 32)
        danger_days = sum(1 for h in historical_hi if h >= 40)

        # Prévisions (16 prochains jours)
        forecast = []
        for i, hi in enumerate(forecast_hi):
            idx = past_count + i
            if idx < len(dates):
                t = temp_max[idx] if idx < len(temp_max) and temp_max[idx] is not None else 20.0
                h = rh_min[idx] if idx < len(rh_min) and rh_min[idx] is not None else 50.0
                lvl = _heat_level(hi)
                forecast.append({
                    "date": dates[idx],
                    "hi": round(hi, 1),
                    "temp_max": round(t, 1),
                    "rh_min": round(h, 0),
                    "level": lvl["level"],
                    "label": lvl["label"],
                    "color": lvl["color"],
                })

        return {
            "current_hi": round(current_hi, 1),
            "current_temp": round(current_temp, 1),
            "current_rh": round(current_rh, 0),
            "risk_level": risk["level"],
            "risk_label": risk["label"],
            "risk_color": risk["color"],
            "avg_hi_92d": round(avg_hi, 1),
            "max_hi_92d": round(max_hi, 1),
            "hot_days_92d": hot_days,
            "danger_days_92d": danger_days,
            "forecast_16day": forecast,
            "source": "Open-Meteo Forecast API ~1-11km",
            "unit": "°C",
        }

    except httpx.HTTPError as exc:
        logger.warning("heat_stress -- erreur HTTP pour %.4f, %.4f: %s", lat, lon, exc)
        return None
    except Exception as exc:
        logger.warning("heat_stress -- erreur inattendue pour %.4f, %.4f: %s", lat, lon, exc)
        return None
