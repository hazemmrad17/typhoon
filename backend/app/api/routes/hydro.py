"""Routes du trajet de l'eau (étape 2).

  GET /api/hydro          — réseau hydrographique RÉEL (IGN BD TOPO) autour
                            d'un point : accrochage, parcours amont / aval
                            bornés, bassin versant, profil en long réel,
                            temps de propagation estimé.
  GET /api/hydro/extend   — poursuite d'un parcours borné depuis son curseur.
  GET /api/meteo          — référence RÉELLE (Open-Meteo / GloFAS) : pluie
                            prévue, débit de rivière estimé.

Aucune de ces routes ne lève jamais : un service externe indisponible produit
une réponse valide dont les sections sont nulles et la raison renseignée.
"""

from __future__ import annotations

from fastapi import APIRouter, Query

from app.connectors import hydro as hydro_conn
from app.connectors import meteo as meteo_conn
from app.core.logging import get_logger
from app.schemas.hydro import HydroRouteOut, HydroStretchOut, MeteoOut

logger = get_logger(__name__)
router = APIRouter()


@router.get("/api/hydro", response_model=HydroRouteOut, tags=["hydro"])
async def get_hydro(
    lat: float = Query(..., ge=-90, le=90, description="Latitude (WGS84)"),
    lon: float = Query(..., ge=-180, le=180, description="Longitude (WGS84)"),
    budget: int = Query(
        hydro_conn.DEFAULT_BUDGET,
        ge=1,
        le=hydro_conn.MAX_BUDGET,
        description="Tronçons maximum reconstruits par sens (borne de latence)",
    ),
) -> HydroRouteOut:
    logger.info("GET /api/hydro  lat=%.5f lon=%.5f budget=%s", lat, lon, budget)
    return HydroRouteOut(**await hydro_conn.build_hydro(lat, lon, budget))


@router.get("/api/hydro/extend", response_model=HydroStretchOut, tags=["hydro"])
async def extend_hydro(
    cursor: str = Query(..., description="Curseur renvoyé par un parcours borné"),
    budget: int = Query(
        hydro_conn.DEFAULT_BUDGET,
        ge=1,
        le=hydro_conn.MAX_BUDGET,
    ),
) -> HydroStretchOut:
    logger.info("GET /api/hydro/extend  curseur=%r budget=%s", cursor[:60], budget)
    payload = await hydro_conn.extend_stretch(cursor, budget)
    return HydroStretchOut(**payload)


@router.get("/api/meteo", response_model=MeteoOut, tags=["hydro"])
async def get_meteo(
    lat: float = Query(..., ge=-90, le=90, description="Latitude (WGS84)"),
    lon: float = Query(..., ge=-180, le=180, description="Longitude (WGS84)"),
) -> MeteoOut:
    logger.info("GET /api/meteo  lat=%.5f lon=%.5f", lat, lon)
    return MeteoOut(**await meteo_conn.fetch_meteo(lat, lon))
