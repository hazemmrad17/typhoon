"""
Connecteur de risque de vent via Open-Meteo Forecast API.

Évalue le risque de dégâts liés au vent pour un bâtiment :
- Dommages structurels (toiture, façade)
- Chutes d'arbres et objets
- Interruptions d'alimentation

Classification des vents (échelle Météo-France) :
- < 39 km/h  : faible (pas de dégâts)
- 39-61 km/h  : modéré (brindilles, éléments mobiles)
- 62-88 km/h  : fort (branches, tuiles)
- 89-102 km/h : très fort (dégâts importants)
- > 102 km/h  : tempête (dégâts majeurs)

Source : Open-Meteo Forecast API (gratuit, sans clé API)
  - Résolution : 1-11 km (modèle best_match)
  - Variables : wind_speed_10m_max, wind_gusts_10m_max
  - Données : journalier, historique jusqu'à 92 jours

API : https://open-meteo.com/en/docs
"""

from __future__ import annotations

from typing import Any

import httpx

from app.core.logging import get_logger

logger = get_logger(__name__)

FORECAST_API_BASE = "https://api.open-meteo.com/v1/forecast"


def _wind_level(speed: float) -> dict[str, str]:
    """Convertit une vitesse de vent (km/h) en niveau de risque."""
    if speed >= 102:
        return {"level": "extreme", "label": "Tempête", "color": "#B03020"}
    if speed >= 89:
        return {"level": "very_high", "label": "Très fort", "color": "#C04030"}
    if speed >= 62:
        return {"level": "high", "label": "Fort", "color": "#D07030"}
    if speed >= 39:
        return {"level": "moderate", "label": "Modéré", "color": "#D4AC3E"}
    return {"level": "low", "label": "Faible", "color": "#3A7A6C"}


async def fetch_wind_risk(lat: float, lon: float) -> dict[str, Any] | None:
    """Récupère les données de risque de vent pour une coordonnée.

    Retourne :
    - current_speed : vitesse maximale actuelle (km/h)
    - current_gusts : rafales maximales actuelles (km/h)
    - risk_level : niveau de risque
    - forecast_7day : prévisions 7 jours
    - max_speed_30d : vitesse max sur 30 jours
    - storm_days_30d : nombre de jours avec vent > 89 km/h
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
                        "wind_speed_10m_max",
                        "wind_gusts_10m_max",
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
        wind_speed = daily.get("wind_speed_10m_max", [])
        wind_gusts = daily.get("wind_gusts_10m_max", [])

        if not dates:
            logger.warning("wind_risk -- pas de données pour %.4f, %.4f", lat, lon)
            return None

        # Filtrer les valeurs valides
        valid_speeds = [v for v in wind_speed if v is not None]
        if not valid_speeds:
            return None

        # Vent actuel = dernier jour disponible
        past_count = min(92, len(dates))
        current_speed = wind_speed[past_count - 1] if past_count - 1 < len(wind_speed) and wind_speed[past_count - 1] is not None else 0
        current_gusts = wind_gusts[past_count - 1] if past_count - 1 < len(wind_gusts) and wind_gusts[past_count - 1] is not None else current_speed * 1.5
        risk = _wind_level(current_speed)

        # Statistiques historiques (92 jours)
        historical_speeds = [v for v in wind_speed[:past_count] if v is not None]
        max_speed = max(historical_speeds) if historical_speeds else 0
        avg_speed = sum(historical_speeds) / len(historical_speeds) if historical_speeds else 0
        storm_days = sum(1 for v in historical_speeds if v >= 89)
        strong_days = sum(1 for v in historical_speeds if v >= 62)

        # Prévisions (16 prochains jours)
        forecast = []
        for i in range(past_count, min(past_count + 16, len(dates))):
            spd = wind_speed[i] if i < len(wind_speed) and wind_speed[i] is not None else 0
            gst = wind_gusts[i] if i < len(wind_gusts) and wind_gusts[i] is not None else spd * 1.5
            lvl = _wind_level(spd)
            forecast.append({
                "date": dates[i],
                "speed": round(spd, 1),
                "gusts": round(gst, 1),
                "level": lvl["level"],
                "label": lvl["label"],
                "color": lvl["color"],
            })

        return {
            "current_speed": round(current_speed, 1),
            "current_gusts": round(current_gusts, 1),
            "risk_level": risk["level"],
            "risk_label": risk["label"],
            "risk_color": risk["color"],
            "avg_speed_92d": round(avg_speed, 1),
            "max_speed_92d": round(max_speed, 1),
            "storm_days_92d": storm_days,
            "strong_days_92d": strong_days,
            "forecast_16day": forecast,
            "source": "Open-Meteo Forecast API ~1-11km",
            "unit": "km/h",
        }

    except httpx.HTTPError as exc:
        logger.warning("wind_risk -- erreur HTTP pour %.4f, %.4f: %s", lat, lon, exc)
        return None
    except Exception as exc:
        logger.warning("wind_risk -- erreur inattendue pour %.4f, %.4f: %s", lat, lon, exc)
        return None
