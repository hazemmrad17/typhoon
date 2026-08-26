"""
Routes de diagnostic Typhoon — contrat brut sans scoring.

Le produit est la fusion de données brutes (Géorisques + BDNB) par
bâtiment, avec provenance et résolution. Le scoring, le jumeau numérique
3D, les simulations, Copernicus et Open-Meteo sont supprimés.

Routes actives :
  POST /diagnostic/adresse      → collecte + fusion, retourne le contrat brut
  POST /diagnostic/batch        → même chose pour une liste d'adresses
  GET  /diagnostic/batch/{id}   → polling
  GET  /diagnostic/adresse/rapport-pdf → proxy PDF Géorisques
  GET  /diagnostic/zone/building → fiche bâtiment par ID
  GET  /diagnostic/zone/buildings → bâtiments par bbox
"""

from __future__ import annotations

import time
import uuid

from typing import Literal

import httpx
from fastapi import APIRouter, HTTPException, Query, Response
from fastapi.responses import Response as FastAPIResponse
from pydantic import BaseModel, Field

from app.agents.collector_agent import collect
from app.connectors.bdnb import (
    BdnbAdresseIntrouvable,
    fetch_batiment_groupe,
    fetch_bdnb,
    fetch_buildings_in_bbox,
)
from app.connectors.geocoding import GeocodingError, geocode_address
from app.core.config import settings
from app.core.logging import get_logger
from app.services import batch as batch_service
from app.services import budget
from app.services.canonical import AdresseAmbigueError, build_diagnostic_record

logger = get_logger(__name__)
router = APIRouter()


# ---------------------------------------------------------------------------
# Contrat de sortie brut (§1 du plan de refonte)
# ---------------------------------------------------------------------------

class DiagnosticRequest(BaseModel):
    adresse: str = Field(..., min_length=3, description="Adresse postale complète du bien")


@router.post("/diagnostic/adresse")
async def diagnostic_adresse_post(payload: DiagnosticRequest) -> dict:
    """
    Transaction produit : une adresse française -> un DiagnosticRecord canonique.

    Portes de géocodage avant tout appel source :
      422 adresse_ambigue      (score < 0.4, label_propose fourni)
      422 adresse_non_trouvee
      502 geocodage_indisponible
    Dégradation : échec BDNB -> 200 partiel avec erreurs_partielles.
    """
    logger.info("POST /diagnostic/adresse  adresse=%r", payload.adresse)
    t0 = time.perf_counter()

    try:
        record = await build_diagnostic_record(payload.adresse)
    except AdresseAmbigueError as exc:
        raise HTTPException(
            status_code=422,
            detail={
                "error": "adresse_ambigue",
                "detail": str(exc),
                "label_propose": exc.label_propose,
            },
        ) from exc
    except GeocodingError as exc:
        raise HTTPException(
            status_code=422,
            detail={"error": "adresse_non_trouvee", "detail": str(exc)},
        ) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502,
            detail={"error": "geocodage_indisponible", "detail": str(exc)},
        ) from exc
    except Exception as exc:
        logger.exception("diagnostic/adresse -- échec pour %r", payload.adresse)
        raise HTTPException(status_code=502, detail=f"{type(exc).__name__}: {exc}") from exc

    elapsed = time.perf_counter() - t0
    logger.info(
        "diagnostic/adresse OK en %.2fs — %d aléas, %d erreur(s) partielle(s)",
        elapsed, len(record.aleas), len(record.erreurs_partielles),
    )
    return record.model_dump(by_alias=True)


# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Batch interne (Portfolio)
# ---------------------------------------------------------------------------

class InternalBatchRequest(BaseModel):
    addresses: list[str] = Field(..., min_length=1, max_length=10000)


@router.post("/diagnostic/batch")
async def submit_internal_batch(payload: InternalBatchRequest) -> dict:
    """Soumet un lot d'adresses (FR-20) — N × le pipeline canonique."""
    logger.info("POST /diagnostic/batch  n=%d", len(payload.addresses))

    # FR-28 : le lot est refusé si l'enveloppe mensuelle BDNB ne couvre pas
    # sa taille. La requête unitaire interactive n'est jamais bloquée par ce
    # garde en v1.
    if budget.remaining(settings.bdnb_monthly_budget) < len(payload.addresses):
        raise HTTPException(
            status_code=429,
            detail={
                "error": "budget_epuise",
                "detail": (
                    "Enveloppe mensuelle BDNB insuffisante pour ce lot "
                    f"({budget.remaining(settings.bdnb_monthly_budget)}/"
                    f"{settings.bdnb_monthly_budget} restants). "
                    "Passer sur BDNB Open Plus ou attendre la réinitialisation."
                ),
            },
        )

    async def analyze_address(address: str) -> dict:
        record = await build_diagnostic_record(address)
        return record.model_dump(by_alias=True)

    try:
        return batch_service.submit_batch(payload.addresses, analyzer=analyze_address)
    except Exception as exc:
        logger.exception("diagnostic/batch -- échec soumission")
        raise HTTPException(status_code=502, detail=f"{type(exc).__name__}: {exc}") from exc


@router.get("/diagnostic/batch/{batch_id}")
async def poll_internal_batch(batch_id: str) -> dict:
    """État d'un lot interne (polling). 404 si le batch_id est inconnu."""
    batch = batch_service.get_batch(batch_id)
    if batch is None:
        raise HTTPException(status_code=404, detail=f"lot inconnu : {batch_id}")
    return batch


# ---------------------------------------------------------------------------
# PDF Géorisques (proxy)
# ---------------------------------------------------------------------------

@router.get("/diagnostic/adresse/rapport-pdf")
async def rapport_pdf_officiel(
    lat: float = Query(..., description="Latitude WGS84"),
    lon: float = Query(..., description="Longitude WGS84"),
):
    """Proxy vers l'endpoint officiel Géorisques /api/v1/rapport_pdf."""
    georisques_pdf_url = "https://www.georisques.gouv.fr/api/v1/rapport_pdf"
    params = {"latlon": f"{lon},{lat}"}

    try:
        async with httpx.AsyncClient(timeout=25.0) as client:
            resp = await client.get(georisques_pdf_url, params=params)
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status_code=502,
            detail={"error": "rapport_pdf_timeout", "detail": str(exc)},
        ) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502,
            detail={"error": "rapport_pdf_indisponible", "detail": str(exc)},
        ) from exc

    if resp.status_code == 404:
        raise HTTPException(
            status_code=404,
            detail={"error": "rapport_pdf_indisponible", "detail": "Géorisques ne peut pas générer de rapport PDF pour ces coordonnées."},
        )

    if resp.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail={"error": "rapport_pdf_erreur", "detail": f"Géorisques a retourné HTTP {resp.status_code}"},
        )

    return FastAPIResponse(
        content=resp.content,
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename=\"georisques_rapport_{lat:.4f}_{lon:.4f}.pdf\""},
    )


# ---------------------------------------------------------------------------
# Bâtiments (fiche + bbox)
# ---------------------------------------------------------------------------

@router.get("/diagnostic/zone/building")
async def zone_building(
    id: str = Query(..., min_length=9, description="batiment_groupe_id BDNB"),
) -> dict:
    """Fiche complète d'un bâtiment par identifiant."""
    logger.info("GET /diagnostic/zone/building  id=%r", id)
    async with httpx.AsyncClient(timeout=20) as client:
        try:
            fiche = await fetch_batiment_groupe(client, id)
        except Exception as exc:
            logger.warning(
                "  [zone/building] BDNB indisponible pour %r -> %s: %s",
                id, type(exc).__name__, exc,
            )
            raise HTTPException(
                status_code=502,
                detail={"error": "bdnb_fiche_erreur", "detail": str(exc)},
            ) from exc
    if fiche is None:
        raise HTTPException(
            status_code=404,
            detail={"error": "batiment_inconnu", "detail": f"Aucun bâtiment BDNB pour {id!r}."},
        )
    return fiche


@router.get("/diagnostic/zone/buildings")
async def zone_buildings(
    west: float = Query(..., description="Ouest de la bbox (WGS84)"),
    south: float = Query(..., description="Sud de la bbox (WGS84)"),
    east: float = Query(..., description="Est de la bbox (WGS84)"),
    north: float = Query(..., description="Nord de la bbox (WGS84)"),
    limit: int = Query(60, ge=0, le=10000, description="Nombre max de bâtiments"),
) -> dict:
    """Retourne les bâtiments BDNB intersectant la bbox du viewport."""
    async with httpx.AsyncClient(timeout=30) as client:
        try:
            return await fetch_buildings_in_bbox(
                client, west=west, south=south, east=east, north=north, limit=limit
            )
        except Exception as exc:
            logger.warning("  [zone/buildings] BDNB bbox indisponible -> %s: %s", type(exc).__name__, exc)
            raise HTTPException(
                status_code=502,
                detail={"error": "bdnb_bbox_erreur", "detail": str(exc)},
            ) from exc
