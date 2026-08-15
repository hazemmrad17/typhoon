from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.core.logging import get_logger
from partner_api.auth import require_api_key
from partner_api.schemas import (
    AnalyzeRequest,
    AnalyzeResponse,
    BatchPollResponse,
    BatchRequest,
    BatchSubmitResponse,
)
from partner_api.service import AddressNotFound, analyze_address, get_batch, submit_batch

logger = get_logger(__name__)
router = APIRouter(prefix="/v1", tags=["analyze"])


@router.post("/analyze", response_model=AnalyzeResponse)
async def analyze(payload: AnalyzeRequest, partner: str = Depends(require_api_key)) -> AnalyzeResponse:
    logger.info(
        "partner_api /v1/analyze -- partenaire=%r adresse=%r scenario=%s",
        partner, payload.address, payload.scenario,
    )
    try:
        return await analyze_address(payload.address, scenario=payload.scenario)
    except AddressNotFound as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("partner_api /v1/analyze -- echec pour %r", payload.address)
        raise HTTPException(status_code=502, detail=f"{type(exc).__name__}: {exc}") from exc


@router.post("/batch", response_model=BatchSubmitResponse, tags=["batch"])
async def submit_batch_route(payload: BatchRequest, partner: str = Depends(require_api_key)) -> BatchSubmitResponse:
    """Soumet un lot d'adresses (livre entier) et le traite en arriere-plan.

    Retourne un `batch_id` a poller via GET /v1/batch/{batch_id}. Meme
    contrat par adresse que /v1/analyze (dont la `trajectoire`) — une adresse
    en erreur ne fait pas echouer le lot.
    """
    logger.info(
        "partner_api /v1/batch -- partenaire=%r n=%d scenario=%s",
        partner, len(payload.addresses), payload.scenario,
    )
    try:
        return submit_batch(payload.addresses, scenario=payload.scenario)
    except Exception as exc:
        logger.exception("partner_api /v1/batch -- echec soumission")
        raise HTTPException(status_code=502, detail=f"{type(exc).__name__}: {exc}") from exc


@router.get("/batch/{batch_id}", response_model=BatchPollResponse, tags=["batch"])
async def poll_batch(batch_id: str, partner: str = Depends(require_api_key)) -> BatchPollResponse:
    """Etat d'un lot soumis (polling). 404 si le batch_id est inconnu."""
    batch = get_batch(batch_id)
    if batch is None:
        raise HTTPException(status_code=404, detail=f"lot inconnu : {batch_id}")
    return batch
