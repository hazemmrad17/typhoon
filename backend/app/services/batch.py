"""
Service batch interne Typhoon (Ticket 3 — insurerpagesplan).

Logique de soumission/polling d'un lot d'adresses, extraite de
`partner_api/service.py` pour etre reutilisable par la route interne
`/diagnostic/batch` (Portfolio) SANS exposer une cle d'API dans le JS
du navigateur. Le contrat reste celui de la Partner API (meme forme par
adresse : `result` = AnalyseResponse, `error` = message).

Le store est en memoire (process-local) — suffisant pour un premier
lancement ; un backend durable viendra avec la mise en production.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from app.core.logging import get_logger

logger = get_logger(__name__)

# Store en memoire (process-local) : un backend durable (Redis/Postgres)
# viendra avec la mise en production. TTL simple pour eviter une fuite memoire.
_BATCH_TTL_S = 24 * 3600
_BATCH_MAX_CONCURRENCY = 8

_batches: dict[str, dict[str, Any]] = {}

# Analyseur par adresse — injecte par la route/appelant (injection explicite
# plutot que d'importer l'agent ici : evite tout cycle et garde le service
# generique, ni "partner" ni "diagnostic").
Analyzer = Callable[[str, str], Awaitable[Any]]

_STATUS_PENDING = "pending"
_STATUS_PROCESSING = "processing"
_STATUS_COMPLETED = "completed"
_STATUS_FAILED = "failed"


def _batch_status(batch: dict[str, Any]) -> str:
    states = {it["status"] for it in batch["items"]}
    if states <= {_STATUS_COMPLETED, _STATUS_FAILED}:
        return "completed"
    if _STATUS_PROCESSING in states:
        return "processing"
    return "queued"


async def _run_batch_worker(batch_id: str, analyzer: Analyzer) -> None:
    """Traite les adresses du lot avec une concurrence bornee."""
    batch = _batches[batch_id]
    semaphore = asyncio.Semaphore(_BATCH_MAX_CONCURRENCY)

    async def process_item(item: dict[str, Any]) -> None:
        async with semaphore:
            if item["status"] != _STATUS_PENDING:
                return
            item["status"] = _STATUS_PROCESSING
            try:
                item["result"] = await analyzer(
                    item["address"], scenario=item.get("scenario", "rcp8_5")
                )
                item["status"] = _STATUS_COMPLETED
            except Exception as exc:  # une adresse ne doit pas tuer le lot
                logger.exception("batch %s -- echec pour %r", batch_id, item["address"])
                item["status"] = _STATUS_FAILED
                item["error"] = f"{type(exc).__name__}: {exc}"

    await asyncio.gather(*(process_item(item) for item in batch["items"]))
    batch["done_at"] = datetime.now(timezone.utc).isoformat()


def submit_batch(addresses: list[str], analyzer: Analyzer, scenario: str = "rcp8_5") -> dict[str, Any]:
    """Cree un lot et lance son traitement en arriere-plan.

    Retourne un dict `{batch_id, status, total}` (meme forme que le contrat
    Partner API BatchSubmitResponse).
    """
    batch_id = uuid.uuid4().hex[:12]
    batch: dict[str, Any] = {
        "id": batch_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "items": [
            {
                "address": a,
                "scenario": scenario,
                "status": _STATUS_PENDING,
                "result": None,
                "error": None,
            }
            for a in addresses
        ],
    }
    _batches[batch_id] = batch
    asyncio.get_running_loop().create_task(_run_batch_worker(batch_id, analyzer))
    return {"batch_id": batch_id, "status": "queued", "total": len(addresses)}


def get_batch(batch_id: str) -> dict[str, Any] | None:
    """Etat d'un lot (polling). Retourne None si le lot n'existe pas.

    Retourne un dict avec la meme forme que BatchPollResponse Partner API :
    `{batch_id, status, total, completed, failed, items:[{address, status,
    result, error}]}`.
    """
    batch = _batches.get(batch_id)
    if batch is None:
        return None
    items = batch["items"]
    return {
        "batch_id": batch_id,
        "status": _batch_status(batch),
        "total": len(items),
        "completed": sum(1 for it in items if it["status"] == _STATUS_COMPLETED),
        "failed": sum(1 for it in items if it["status"] == _STATUS_FAILED),
        "items": [
            {
                "address": it["address"],
                "status": it["status"],
                "result": it["result"],
                "error": it["error"],
            }
            for it in items
        ],
    }
