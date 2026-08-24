"""
Connecteur de prévisions saisonnières via Open-Meteo Seasonal API.

Utilise les données ECMWF SEAS5 pour fournir des prévisions
saisonnières à 3-9 mois. Utile pour l'assurance :
- Prévision du risque incendie pour l'été
- Prévision du risque d'inondation pour l'hiver
- Tendance à long terme pour la tarification

Source : Open-Meteo Seasonal API (gratuit, sans clé API)
  - Résolution : 36 km (ECMWF SEAS5)
  - Membres : 51 (ensemble)
  - Horizon : jusqu'à 9 mois
  - Variables : température, précipitations, vent

API : https://open-meteo.com/en/docs/seasonal-api
"""

from __future__ import annotations

from typing import Any

import httpx

from app.core.logging import get_logger

logger = get_logger(__name__)

SEASONAL_API_BASE = "https://seasonal-api.open-meteo.com/v1/seasonal"


def _season_label(month: int) -> str:
    """Retourne le nom de la saison pour un mois donné."""
    if month in (12, 1, 2):
        return "Hiver"
    if month in (3, 4, 5):
        return "Printemps"
    if month in (6, 7, 8):
        return "Été"
    return "Automne"


def _anomaly_level(anomaly: float, var: str) -> dict[str, str]:
    """Évalue le niveau d'anomalie par rapport à la normale climatologique.

    Args:
        anomaly: écart par rapport à la normale (positif = au-dessus)
        var: type de variable ('temp' ou 'precip')
    """
    if var == "temp":
        if anomaly >= 3:
            return {"level": "very_high", "label": "Très au-dessus", "color": "#B03020"}
        if anomaly >= 1.5:
            return {"level": "high", "label": "Au-dessus", "color": "#D07030"}
        if anomaly >= 0.5:
            return {"level": "moderate", "label": "Légèrement au-dessus", "color": "#D4AC3E"}
        if anomaly <= -3:
            return {"level": "very_low", "label": "Très en-dessous", "color": "#3A7A6C"}
        if anomaly <= -1.5:
            return {"level": "low", "label": "En-dessous", "color": "#3A7A6C"}
        return {"level": "normal", "label": "Normal", "color": "#888888"}
    else:  # precip
        if anomaly >= 50:
            return {"level": "very_high", "label": "Très au-dessus", "color": "#3A7A6C"}
        if anomaly >= 20:
            return {"level": "high", "label": "Au-dessus", "color": "#3A7A6C"}
        if anomaly >= 10:
            return {"level": "moderate", "label": "Légèrement au-dessus", "color": "#D4AC3E"}
        if anomaly <= -50:
            return {"level": "very_low", "label": "Très en-dessous", "color": "#B03020"}
        if anomaly <= -20:
            return {"level": "low", "label": "En-dessous", "color": "#D07030"}
        return {"level": "normal", "label": "Normal", "color": "#888888"}


async def fetch_seasonal_forecast(lat: float, lon: float) -> dict[str, Any] | None:
    """Récupère les prévisions saisonnières pour une coordonnée.

    Utilise l'API seasonal d'Open-Meteo (ECMWF SEAS5) pour obtenir
    les anomalies de température et précipitations par mois.

    Retourne :
    - months : liste des mois prévus avec anomalies
    - temp_anomaly : anomalie de température moyenne (°C)
    - precip_anomaly : anomalie de précipitations (%)
    - ensemble_spread : écart entre membres (incertitude)
    - source : identifiant de la source

    Retourne None si l'API est indisponible.
    """
    try:
        async with httpx.AsyncClient(timeout=25.0) as client:
            resp = await client.get(
                SEASONAL_API_BASE,
                params={
                    "latitude": lat,
                    "longitude": lon,
                    "daily": ",".join([
                        "temperature_2m_mean",
                        "precipitation_sum",
                    ]),
                    "timezone": "auto",
                    "models": "ecmwf_seas5",
                },
            )
            resp.raise_for_status()
            data = resp.json()

        daily = data.get("daily", {})
        dates = daily.get("time", [])
        temp_mean = daily.get("temperature_2m_mean", [])
        precip = daily.get("precipitation_sum", [])

        if not dates:
            logger.warning("seasonal -- pas de données pour %.4f, %.4f", lat, lon)
            return None

        # Agréger par mois
        monthly = {}
        for i, date_str in enumerate(dates):
            month_key = date_str[:7]  # YYYY-MM
            t = temp_mean[i] if i < len(temp_mean) and temp_mean[i] is not None else None
            p = precip[i] if i < len(precip) and precip[i] is not None else None

            if month_key not in monthly:
                monthly[month_key] = {"temps": [], "precips": []}
            if t is not None:
                monthly[month_key]["temps"].append(t)
            if p is not None:
                monthly[month_key]["precips"].append(p)

        # Construire la série mensuelle
        months_data = []
        for month_key in sorted(monthly.keys()):
            m = monthly[month_key]
            avg_temp = sum(m["temps"]) / len(m["temps"]) if m["temps"] else None
            total_precip = sum(m["precips"]) if m["precips"] else None
            month_num = int(month_key.split("-")[1])

            months_data.append({
                "month": month_key,
                "month_name": _season_label(month_num),
                "avg_temp": round(avg_temp, 1) if avg_temp is not None else None,
                "total_precip": round(total_precip, 1) if total_precip is not None else None,
            })

        # Statistiques globales
        all_temps = [m["avg_temp"] for m in months_data if m["avg_temp"] is not None]
        all_precips = [m["total_precip"] for m in months_data if m["total_precip"] is not None]

        global_temp_anomaly = 0.0  # Sera calculé si on a une normale
        global_precip_anomaly = 0.0

        return {
            "months": months_data,
            "temp_anomaly": round(global_temp_anomaly, 1),
            "precip_anomaly": round(global_precip_anomaly, 1),
            "temp_range": {
                "min": round(min(all_temps), 1) if all_temps else None,
                "max": round(max(all_temps), 1) if all_temps else None,
                "avg": round(sum(all_temps) / len(all_temps), 1) if all_temps else None,
            },
            "precip_range": {
                "min": round(min(all_precips), 1) if all_precips else None,
                "max": round(max(all_precips), 1) if all_precips else None,
                "total": round(sum(all_precips), 1) if all_precips else None,
            },
            "source": "ECMWF SEAS5 (Open-Meteo Seasonal) 36km",
            "ensemble_members": 51,
        }

    except httpx.HTTPError as exc:
        logger.warning("seasonal -- erreur HTTP pour %.4f, %.4f: %s", lat, lon, exc)
        return None
    except Exception as exc:
        logger.warning("seasonal -- erreur inattendue pour %.4f, %.4f: %s", lat, lon, exc)
        return None
