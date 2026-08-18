"""
Routes de diagnostic Typhoon — contrat brut sans scoring.

Le produit se recentre sur la fusion de données brutes (Géorisques + BDNB +
Copernicus) par bâtiment. Le scoring, le jumeau numérique 3D et les
simulations sont supprimés.

Routes actives :
  POST /diagnostic/adresse      → collecte + fusion, retourne le contrat brut
  POST /diagnostic/batch        → même chose pour une liste d'adresses
  GET  /diagnostic/batch/{id}   → polling
  GET  /diagnostic/copernicus/status → état du pipeline
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
from app.connectors.georisques import get_risque_report
from app.connectors.copernicus import copernicus_status
from app.core.config import settings
from app.core.logging import get_logger
from app.services import batch as batch_service

logger = get_logger(__name__)
router = APIRouter()


# ---------------------------------------------------------------------------
# Contrat de sortie brut (§1 du plan de refonte)
# ---------------------------------------------------------------------------

class DiagnosticRequest(BaseModel):
    adresse: str = Field(..., min_length=3, description="Adresse postale complète du bien")
    copernicus: bool = Field(
        default=settings.copernicus_enabled,
        description="Activer/désactiver Copernicus (CDS) dans la collecte.",
    )


@router.post("/diagnostic/adresse")
async def diagnostic_adresse_post(payload: DiagnosticRequest) -> dict:
    """
    Collecte des données brutes pour une adresse.

    Retourne le contrat brut (§1) :
      - adresse : geocodage
      - bdnb : fiche bâtiment complète
      - georisques : aléas réglementaires
      - copernicus : projections climatiques
      - erreurs_sources : liste des erreurs
      - genere_le : timestamp UTC
    """
    logger.info("POST /diagnostic/adresse  adresse=%r", payload.adresse)
    t0 = time.perf_counter()

    try:
        building_data = await collect(payload.adresse, enable_copernicus=payload.copernicus)
    except Exception as exc:
        logger.exception("diagnostic/adresse -- échec pour %r", payload.adresse)
        raise HTTPException(status_code=502, detail=f"{type(exc).__name__}: {exc}") from exc

    elapsed = time.perf_counter() - t0
    logger.info(
        "diagnostic/adresse OK en %.2fs (%d erreur(s) de source)",
        elapsed, len(building_data.get("erreurs_sources", [])),
    )
    return building_data


# ---------------------------------------------------------------------------
# Ancienne route GET (compatibilité frontend)
# ---------------------------------------------------------------------------

async def _fetch_bdnb_avec_repli(
    client: httpx.AsyncClient, address: str, label_ban: str
) -> dict | None:
    """Interroge BDNB avec repli de géocodage."""
    try:
        return await fetch_bdnb(client, label_ban)
    except BdnbAdresseIntrouvable:
        if label_ban == address:
            raise
        logger.info(
            "  [bdnb] libellé BAN non trouvé (%r), nouvel essai avec l'adresse brute (%r)",
            label_ban, address,
        )
        return await fetch_bdnb(client, address)


@router.get("/diagnostic/adresse")
async def diagnostic_adresse_get(
    q: str = Query(..., min_length=3, description="Adresse française (texte libre)")
) -> dict:
    """
    Flux souverain : adresse saisie → géocodage IGN → Géorisques → contrat brut.

    Codes de retour :
      200 : rapport complet (peut contenir erreurs_partielles si une sous-API a échoué)
      422 : adresse non trouvée par l'IGN
      502 : Géorisques totalement indisponible
    """
    logger.info("GET /diagnostic/adresse  q=%r", q)
    t0 = time.perf_counter()

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            try:
                geo = await geocode_address(client, q)
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

            if geo.score < 0.4:
                raise HTTPException(
                    status_code=422,
                    detail={
                        "error": "adresse_ambigue",
                        "detail": f"Score de géocodage trop faible ({geo.score:.2f}) pour «{q}». Précisez la ville ou le code postal.",
                        "label_propose": geo.label,
                    },
                )

            report = await get_risque_report(
                client=client,
                adresse_saisie=q,
                adresse_normalisee=geo.label,
                lat=geo.lat,
                lon=geo.lon,
                code_insee=geo.citycode,
            )

            # BDNB — fiche bâtiment (non bloquant)
            try:
                report.bdnb = await _fetch_bdnb_avec_repli(client, q, geo.label)
            except BdnbAdresseIntrouvable:
                report.erreurs_partielles.append(
                    "bdnb: adresse non reconnue par le géocodeur BDNB"
                )
            except Exception as exc:
                logger.warning("  [bdnb] ECHEC pour %r -> %s: %s", q, type(exc).__name__, exc)
                report.erreurs_partielles.append(f"bdnb: {type(exc).__name__}: {exc}")

            # Copernicus — projections climatiques (non bloquant)
            if settings.copernicus_enabled:
                try:
                    import asyncio
                    from app.connectors import copernicus as copernicus_connector

                    copernicus_raw = await asyncio.to_thread(
                        copernicus_connector.read_indicators_at_point, geo.lat, geo.lon,
                    )
                    trajectoire = copernicus_connector.extract_trajectoire_brute(copernicus_raw)
                    report.copernicus = {
                        "donnees": copernicus_raw,
                        "trajectoire": trajectoire,
                    }
                except Exception as exc:
                    logger.info("  [copernicus] indisponible pour %r -> %s: %s", q, type(exc).__name__, exc)
                    report.erreurs_partielles.append(f"copernicus: {type(exc).__name__}: {exc}")
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("diagnostic/adresse -- Échec du diagnostic pour %r", q)
        raise HTTPException(
            status_code=502,
            detail={"error": "source_indisponible", "source": "georisques", "detail": str(exc)},
        ) from exc

    elapsed = time.perf_counter() - t0
    logger.info(
        "diagnostic/adresse OK en %.2fs — %d aléas, %d erreurs partielles, bdnb=%s",
        elapsed, report.alea_count, len(report.erreurs_partielles),
        "ok" if report.bdnb else "none",
    )

    return report.model_dump()


# ---------------------------------------------------------------------------
# Batch interne (Portfolio)
# ---------------------------------------------------------------------------

class InternalBatchRequest(BaseModel):
    addresses: list[str] = Field(..., min_length=1, max_length=10000)


@router.post("/diagnostic/batch")
async def submit_internal_batch(payload: InternalBatchRequest) -> dict:
    """Soumet un lot d'adresses (Portfolio) et le traite en arrière-plan."""
    from app.agents.collector_agent import collect as collect_fn

    logger.info("POST /diagnostic/batch  n=%d", len(payload.addresses))

    async def analyze_address(address: str) -> dict:
        """Analyse une adresse : collecte brute sans scoring."""
        return await collect_fn(address, enable_copernicus=True)

    try:
        return batch_service.submit_batch(
            payload.addresses, analyzer=analyze_address
        )
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
# Copernicus status
# ---------------------------------------------------------------------------

@router.get("/diagnostic/copernicus/status")
async def copernicus_status_route() -> dict:
    """État du pipeline Copernicus."""
    return copernicus_status()


class CopernicusDownloadRequest(BaseModel):
    force: bool = Field(default=False, description="Re-télécharger même si le cache est valide.")


@router.post("/diagnostic/copernicus/download")
async def copernicus_download_route(payload: CopernicusDownloadRequest | None = None) -> dict:
    """Lance le téléchargement CDS en arrière-plan."""
    from app.connectors.copernicus import start_download

    force = bool(payload.force if payload else False)
    logger.info("POST /diagnostic/copernicus/download  force=%s", force)
    result = start_download(force=force)
    if result.get("reason") == "not_configured":
        raise HTTPException(
            status_code=409,
            detail={
                "error": "copernicus_non_configure",
                "detail": "CDSAPI_URL / CDSAPI_KEY absents — renseignez-les dans le .env.",
            },
        )
    return result


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
