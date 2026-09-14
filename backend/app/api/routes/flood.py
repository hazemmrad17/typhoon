"""Route de l'aléa d'inondation TRI (étape 2).

  GET /api/flood-alea — classes officielles de hauteur d'eau (Directive
  Inondation) au point analysé, par scénario (fréquent / moyen / extrême /
  faible). C'est la donnée que la simulation de crue affiche comme REPÈRE
  réglementaire à côté de l'enveloppe du moteur.

Cette route ne lève jamais : service indisponible → réponse typée
`present = null` par scénario, avec sa raison.
"""

from __future__ import annotations

from fastapi import APIRouter, Query

from app.connectors import flood_alea
from app.core.logging import get_logger
from app.schemas.flood import FloodAleaOut

logger = get_logger(__name__)
router = APIRouter()


@router.get("/api/flood-alea", response_model=FloodAleaOut, tags=["flood"])
async def get_flood_alea(
    lat: float = Query(..., ge=-90, le=90, description="Latitude (WGS84)"),
    lon: float = Query(..., ge=-180, le=180, description="Longitude (WGS84)"),
) -> FloodAleaOut:
    logger.info("GET /api/flood-alea  lat=%.5f lon=%.5f", lat, lon)
    return FloodAleaOut(**await flood_alea.resolve_flood_alea(lat, lon))
