"""
Routes de données climatiques opérationnelles.

Fournit un endpoint unique qui agrège les données de risque climatique
pour une coordonnée donnée :
- Humidité du sol (ERA5-Land, 9km) — risque argile/subsidence
- Risque d'inondation (GloFAS v4, 5km) — débit rivière + périodes retour
- Danger incendie (FWI, ~10km) — indice feu + prévisions

Usage : GET /api/climate?lat=43.7&lon=7.2
"""

from __future__ import annotations

import asyncio
import time

from fastapi import APIRouter, HTTPException, Query

from app.core.logging import get_logger

logger = get_logger(__name__)

router = APIRouter()


@router.get("/climate")
async def get_climate_data(
    lat: float = Query(..., description="Latitude WGS84"),
    lon: float = Query(..., description="Longitude WGS84"),
) -> dict:
    """Données climatiques opérationnelles pour une coordonnée.

    Agrège les données de trois sources :
    1. Inondation (GloFAS v4 via Open-Meteo) — débit, périodes retour, prévisions
    2. Incendie (FWI via Open-Meteo) — indice danger, prévisions 7 jours
    3. Humidité du sol (ERA5-Land via CDS) — surveillance subsidence

    Toutes les sources sont non-bloquantes : si une source échoue,
    les autres sont quand même retournées.
    """
    logger.info("GET /api/climate lat=%.4f lon=%.4f", lat, lon)
    t0 = time.perf_counter()

    # Validation basique
    if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
        raise HTTPException(
            status_code=422,
            detail={"error": "coordonnees_invalides", "detail": "lat/lon hors limites WGS84"},
        )

    # Collecte parallèle des six sources
    from app.connectors.flood import fetch_flood_risk
    from app.connectors.fire_danger import fetch_fire_danger
    from app.connectors.era5_land import fetch_soil_moisture
    from app.connectors.heat_stress import fetch_heat_stress
    from app.connectors.wind_risk import fetch_wind_risk
    from app.connectors.seasonal import fetch_seasonal_forecast

    flood_task = asyncio.create_task(_safe_fetch("flood", fetch_flood_risk(lat, lon)))
    fire_task = asyncio.create_task(_safe_fetch("fire", fetch_fire_danger(lat, lon)))
    soil_task = asyncio.create_task(_safe_fetch("soil", fetch_soil_moisture(lat, lon)))
    heat_task = asyncio.create_task(_safe_fetch("heat", fetch_heat_stress(lat, lon)))
    wind_task = asyncio.create_task(_safe_fetch("wind", fetch_wind_risk(lat, lon)))
    seasonal_task = asyncio.create_task(_safe_fetch("seasonal", fetch_seasonal_forecast(lat, lon)))

    flood_data, fire_data, soil_data, heat_data, wind_data, seasonal_data = await asyncio.gather(
        flood_task, fire_task, soil_task, heat_task, wind_task, seasonal_task
    )

    elapsed = time.perf_counter() - t0
    logger.info(
        "GET /api/climate OK en %.2fs — flood=%s fire=%s soil=%s heat=%s wind=%s seasonal=%s",
        elapsed,
        "ok" if flood_data else "none",
        "ok" if fire_data else "none",
        "ok" if soil_data else "none",
        "ok" if heat_data else "none",
        "ok" if wind_data else "none",
        "ok" if seasonal_data else "none",
    )

    return {
        "lat": lat,
        "lon": lon,
        "flood": flood_data,
        "fire_danger": fire_data,
        "soil_moisture": soil_data,
        "heat_stress": heat_data,
        "wind_risk": wind_data,
        "seasonal": seasonal_data,
        "metadata": {
            "elapsed_ms": round(elapsed * 1000),
            "sources": {
                "flood": "GloFAS v4 (Open-Meteo) 5km",
                "fire": "Open-Meteo Forecast ~1-11km",
                "soil": "Open-Meteo Forecast ~1-11km",
                "heat": "Open-Meteo Forecast ~1-11km",
                "wind": "Open-Meteo Forecast ~1-11km",
            },
        },
    }


async def _safe_fetch(name: str, coro) -> dict | None:
    """Exécute un fetch et convertit les erreurs en None (fail-soft)."""
    try:
        return await coro
    except Exception as exc:
        logger.warning("climate/%s -- erreur: %s: %s", name, type(exc).__name__, exc)
        return None
