"""
Orchestration de la Typhoon Partner API.

Reutilise directement les agents internes (collector_agent, scoring_agent,
recommandations_agent) plutot que de dupliquer la logique de collecte/scoring :
ce service est une nouvelle facade autour du meme moteur, pas une
reimplementation. digital_twin_agent / interpretation_agent (geometrie 3D,
conclusion redigee) sont volontairement exclus : hors perimetre pour un
partenaire qui veut un score de risque exploitable par API, pas une scene
Three.js.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone
from typing import Any

from app.agents import recommandations_agent, scoring_agent
from app.agents.collector_agent import collect
from app.connectors.geocoding import GeocodingError
from app.core.config import settings
from app.core.logging import get_logger
from app.scoring.risk_model import _niveau

from partner_api.schemas import (
    Address,
    AnalyzeResponse,
    BatchItemResult,
    BatchItemStatus,
    BatchPollResponse,
    BatchSubmitResponse,
    Confidence,
    Hazard,
    RiskPeriod,
    Trajectoire,
    TrajectoirePeril,
    TrajectoirePoint,
    Zone,
)

logger = get_logger(__name__)


class AddressNotFound(Exception):
    """L'adresse fournie n'a pas pu etre geocodee."""


def _trajectoire_from_raw(raw: dict[str, Any] | None) -> Trajectoire | None:
    """Traduit le dict interne `risk_scores['trajectoire']` (produit par
    `risk_model.compute_trajectoire`) en contrat public versionne.

    Le contrat interne expose les memes champs ; cette traduction isole la
    Partner API d'un changement interne futur (comme pour les zones).
    """
    if not raw:
        return None
    return Trajectoire(
        horizons=raw.get("horizons", [2026, 2050, 2100]),
        note=raw.get("note", ""),
        perils={
            code: TrajectoirePeril(
                label=data.get("label", code),
                points=[
                    TrajectoirePoint(**point)
                    for point in data.get("points", [])
                ],
            )
            for code, data in raw.get("perils", {}).items()
        },
    )


def _zone_from_raw(raw: dict[str, Any]) -> Zone:
    return Zone(
        risque=raw["risque"],
        niveau=raw["niveau"],
        alea_principal=raw["alea_principal"],
        justification=raw["justification"],
        recommandations=raw.get("recommandations", []),
    )


def _hazard_from_raw(raw: dict[str, Any]) -> Hazard:
    return Hazard(
        label=raw["label"],
        risque=raw["risque"],
        niveau=raw["niveau"],
        justification=raw["justification"],
    )


def _period_from_raw(score_global: int, zones_raw: dict[str, Any], hazards_raw: dict[str, Any]) -> RiskPeriod:
    return RiskPeriod(
        score_global=score_global,
        niveau_global=_niveau(score_global),
        zones={name: _zone_from_raw(z) for name, z in zones_raw.items()},
        risques_par_alea={name: _hazard_from_raw(h) for name, h in hazards_raw.items()},
    )


async def analyze_address(address: str, scenario: str = "rcp8_5") -> AnalyzeResponse:
    """Point d'entree unique de la Partner API : adresse -> risque + recommandations.

    `scenario` (rcp4_5 / rcp8_5) pilote les points projetes de la trajectoire ;
    les deux RCP restent exposes en comparaison (champ `scenarios`).

    Leve AddressNotFound si l'adresse ne peut pas etre geocodee (entree
    invalide, 422 cote route). Toute autre erreur individuelle de source
    (Georisques, BDNB...) ne fait pas echouer l'appel : elle reste
    consignee dans building_data["erreurs"] et le score est calcule avec
    les sources disponibles, comme dans /diagnostic.
    """
    logger.info("partner_api.analyze_address -- adresse=%r scenario=%s", address, scenario)

    try:
        building_data = await collect(address, enable_copernicus=settings.copernicus_enabled)
    except GeocodingError as exc:
        raise AddressNotFound(str(exc)) from exc

    state: dict[str, Any] = {"building_data": building_data, "formulaire": None}
    state.update(scoring_agent.run(state, scenario=scenario))
    state.update(await recommandations_agent.run(state))

    risk_scores = state["risk_scores"]
    adresse_info = building_data.get("adresse") or {}

    return AnalyzeResponse(
        adresse=Address(
            input=address,
            label=adresse_info.get("label", address),
            citycode=adresse_info.get("citycode", ""),
            postcode=adresse_info.get("postcode", ""),
            city=adresse_info.get("city", ""),
            lat=adresse_info.get("lat"),
            lon=adresse_info.get("lon"),
        ),
        score_global=risk_scores["score_global"],
        niveau_global=_niveau(risk_scores["score_global"]),
        confidence=Confidence(
            score=risk_scores["confidence"]["score"],
            niveau=risk_scores["confidence"]["niveau"],
            n_sources_disponibles=risk_scores["confidence"]["n_sources_disponibles"],
            n_sources_total=risk_scores["confidence"]["n_sources_total"],
        ),
        zones={name: _zone_from_raw(z) for name, z in risk_scores["zones"].items()},
        risques_par_alea={name: _hazard_from_raw(h) for name, h in risk_scores["risques_par_alea"].items()},
        projection_2050=_period_from_raw(
            risk_scores["projection_2050"]["score_global"],
            risk_scores["projection_2050"]["zones"],
            risk_scores["projection_2050"]["risques_par_alea"],
        ),
        trajectoire=_trajectoire_from_raw(risk_scores.get("trajectoire")),
        erreurs_sources=building_data.get("erreurs", []),
        genere_le=building_data.get("genere_le", ""),
    )


# ---------------------------------------------------------------------------
# Batch — Phase 4B, item 24 : soumission async + polling
# ---------------------------------------------------------------------------

# Store en memoire (process-local) : suffisant pour un premier lancement. Un
# backend durable (Redis/Postgres) viendra avec la mise en production — voir
# Phase 3 (deploiement) du roadmap. TTL simple pour eviter une fuite memoire.
_BATCH_TTL_S = 24 * 3600
_BATCH_MAX_CONCURRENCY = 8

_batches: dict[str, dict[str, Any]] = {}


def _batch_status(batch: dict[str, Any]) -> str:
    states = {it["status"] for it in batch["items"]}
    if states <= {BatchItemStatus.COMPLETED, BatchItemStatus.FAILED}:
        return "completed"
    if BatchItemStatus.PROCESSING in states:
        return "processing"
    return "queued"


async def _run_batch_worker(batch_id: str) -> None:
    """Traite les adresses du lot avec une concurrence bornee."""
    batch = _batches[batch_id]
    semaphore = asyncio.Semaphore(_BATCH_MAX_CONCURRENCY)

    async def process_item(item: dict[str, Any]) -> None:
        async with semaphore:
            if item["status"] != BatchItemStatus.PENDING:
                return
            item["status"] = BatchItemStatus.PROCESSING
            try:
                item["result"] = await analyze_address(item["address"], scenario=item.get("scenario", "rcp8_5"))
                item["status"] = BatchItemStatus.COMPLETED
            except AddressNotFound as exc:
                item["status"] = BatchItemStatus.FAILED
                item["error"] = f"adresse non trouvee : {exc}"
            except Exception as exc:  # une adresse ne doit pas tuer le lot
                logger.exception("batch %s -- echec pour %r", batch_id, item["address"])
                item["status"] = BatchItemStatus.FAILED
                item["error"] = f"{type(exc).__name__}: {exc}"

    await asyncio.gather(*(process_item(item) for item in batch["items"]))
    batch["done_at"] = datetime.now(timezone.utc).isoformat()


def submit_batch(addresses: list[str], scenario: str = "rcp8_5") -> BatchSubmitResponse:
    """Cree un lot et lance son traitement en arriere-plan."""
    batch_id = uuid.uuid4().hex[:12]
    batch: dict[str, Any] = {
        "id": batch_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "items": [
            {"address": a, "scenario": scenario, "status": BatchItemStatus.PENDING, "result": None, "error": None}
            for a in addresses
        ],
    }
    _batches[batch_id] = batch
    asyncio.get_running_loop().create_task(_run_batch_worker(batch_id))
    return BatchSubmitResponse(batch_id=batch_id, status="queued", total=len(addresses))


def get_batch(batch_id: str) -> BatchPollResponse | None:
    """Etat d'un lot (polling). Retourne None si le lot n'existe pas."""
    batch = _batches.get(batch_id)
    if batch is None:
        return None
    items = batch["items"]
    return BatchPollResponse(
        batch_id=batch_id,
        status=_batch_status(batch),
        total=len(items),
        completed=sum(1 for it in items if it["status"] == BatchItemStatus.COMPLETED),
        failed=sum(1 for it in items if it["status"] == BatchItemStatus.FAILED),
        items=[
            BatchItemResult(
                address=it["address"],
                status=it["status"],
                result=it["result"],
                error=it["error"],
            )
            for it in items
        ],
    )
