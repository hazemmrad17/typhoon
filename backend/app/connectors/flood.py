"""
Connecteur de risque d'inondation via Open-Meteo Flood API.

Utilise les données GloFAS v4 (Global Flood Awareness System) pour fournir
le débit rivière actuel, les périodes de retour, et les prévisions à 30 jours.

Source : Open-Meteo Flood API (gratuit, sans clé API)
  - Résolution : 5 km (GloFAS v4)
  - Données : débit journalier, prévisions jusqu'à 210 jours
  - Périodes de retour : dérivées de la climatologie GloFAS

API : https://open-meteo.com/en/docs/flood-api
"""

from __future__ import annotations

import time
from typing import Any

import httpx

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)

FLOOD_API_BASE = "https://flood-api.open-meteo.com/v1/flood"

# Périodes de retour standard pour l'assurance (années)
RETURN_PERIODS = [5, 10, 20, 50, 100]

# Seuils de risque d'inondation (percentile du débit historique)
FLOOD_RISK_LEVELS = {
    "low": {"max_percentile": 50, "label": "Faible", "color": "#3A7A6C"},
    "moderate": {"max_percentile": 70, "label": "Modéré", "color": "#D4AC3E"},
    "high": {"max_percentile": 90, "label": "Élevé", "color": "#D07030"},
    "critical": {"max_percentile": 100, "label": "Critique", "color": "#B03020"},
}


def _risk_level_for_percentile(percentile: float) -> dict[str, str]:
    """Convertit un percentile de débit en niveau de risque."""
    for level, config in FLOOD_RISK_LEVELS.items():
        if percentile <= config["max_percentile"]:
            return {"level": level, "label": config["label"], "color": config["color"]}
    return {"level": "critical", "label": "Critique", "color": "#B03020"}


async def fetch_flood_risk(lat: float, lon: float) -> dict[str, Any] | None:
    """Récupère le risque d'inondation pour une coordonnée.

    Retourne :
    - current_discharge_m3s : débit actuel (m³/s)
    - return_period : période de retour estimée
    - percentile : position par rapport à l'historique
    - risk_level : niveau de risque (low/moderate/high/critical)
    - forecast_days : prévisions journalières à 30 jours
    - historical_daily : débit historique moyen par jour de l'année

    Retourne None si l'API est indisponible.
    """
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                FLOOD_API_BASE,
                params={
                    "latitude": lat,
                    "longitude": lon,
                    "daily": "river_discharge",
                    "past_days": 365,
                    "forecast_days": 30,
                },
            )
            resp.raise_for_status()
            data = resp.json()

        daily = data.get("daily", {})
        dates = daily.get("time", [])
        discharges = daily.get("river_discharge", [])

        if not dates or not discharges:
            logger.warning("flood -- pas de données pour %.4f, %.4f", lat, lon)
            return None

        # Séparer historique et prévision par index (pas par filtre None)
        # L'API retourne past_days données historiques + forecast_days prévisions
        forecast_count = 30  # forecast_days paramètre
        past_count = len(dates) - forecast_count
        if past_count <= 0:
            past_count = len(dates)
            forecast_count = 0

        historical_discharges = [d for d in discharges[:past_count] if d is not None]
        if not historical_discharges:
            return None

        # Débit actuel = dernier jour historique disponible
        current = historical_discharges[-1]

        # Statistiques historiques
        sorted_hist = sorted(historical_discharges)
        n = len(sorted_hist)
        if current is not None and n > 0:
            rank = sum(1 for v in sorted_hist if v <= current)
            percentile = round((rank / n) * 100, 1)
        else:
            percentile = 50.0

        # Estimation de la période de retour
        if percentile >= 99:
            return_period = "100 ans+"
        elif percentile >= 95:
            return_period = "100 ans"
        elif percentile >= 90:
            return_period = "50 ans"
        elif percentile >= 80:
            return_period = "20 ans"
        elif percentile >= 70:
            return_period = "10 ans"
        elif percentile >= 60:
            return_period = "5 ans"
        else:
            return_period = "< 5 ans"

        risk = _risk_level_for_percentile(percentile)

        # Prévisions (30 prochains jours)
        forecast = []
        for i in range(past_count, len(dates)):
            v = discharges[i] if i < len(discharges) else None
            if v is not None:
                forecast.append({"date": dates[i], "discharge_m3s": round(v, 1)})

        return {
            "current_discharge_m3s": round(current, 1) if current else None,
            "percentile": percentile,
            "return_period": return_period,
            "risk_level": risk["level"],
            "risk_label": risk["label"],
            "risk_color": risk["color"],
            "mean_discharge_m3s": round(sum(historical_discharges) / len(historical_discharges), 1),
            "min_discharge_m3s": round(min(historical_discharges), 1),
            "max_discharge_m3s": round(max(historical_discharges), 1),
            "forecast_30day": forecast,
            "source": "GloFAS v4 (Open-Meteo) 5km",
            "unit": "m³/s",
        }

    except httpx.HTTPError as exc:
        logger.warning("flood -- erreur HTTP pour %.4f, %.4f: %s", lat, lon, exc)
        return None
    except Exception as exc:
        logger.warning("flood -- erreur inattendue pour %.4f, %.4f: %s", lat, lon, exc)
        return None
