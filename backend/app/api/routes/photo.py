"""Route des photos terrain du secteur (étape 2).

  GET /api/photo — photo Panoramax RÉELLE la plus proche du point analysé, avec
                   sa distance, son orientation, sa date, son producteur et sa
                   licence. Sans photo dans le rayon, la réponse est valide et
                   `available = False` avec sa raison.

Cette route ne lève jamais : un service indisponible produit une réponse typée.
Elle ne fait aucun calcul de risque — elle ne sert qu'à montrer le lieu analysé
tel qu'il est, pas une illustration générique.
"""

from __future__ import annotations

from fastapi import APIRouter, Query

from app.connectors import panoramax as panoramax_conn
from app.core.logging import get_logger
from app.schemas.photo import SitePhotoOut

logger = get_logger(__name__)
router = APIRouter()


@router.get("/api/photo", response_model=SitePhotoOut, tags=["photo"])
async def get_site_photo(
    lat: float = Query(..., ge=-90, le=90, description="Latitude (WGS84)"),
    lon: float = Query(..., ge=-180, le=180, description="Longitude (WGS84)"),
    radius: float = Query(
        panoramax_conn.SEARCH_RADIUS_M,
        ge=5.0,
        le=250.0,
        description="Rayon de recherche autour du point (mètres)",
    ),
) -> SitePhotoOut:
    logger.info("GET /api/photo  lat=%.5f lon=%.5f radius=%.0f", lat, lon, radius)
    return SitePhotoOut(**await panoramax_conn.fetch_site_photo(lat, lon, radius))
