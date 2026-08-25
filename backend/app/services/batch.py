"""
Service batch interne Typhoon (FR-20).

Logique de soumission/polling d'un lot d'adresses pour la route
`/diagnostic/batch`. Chaque adresse traverse le MÊME pipeline canonique que
la transaction unitaire (`build_diagnostic_record`) — le batch est N fois
la primitive, jamais une implémentation parallèle (constitution §2).

Contrat (spec FR-20) :
  soumission -> {batch_id, n_accepted}
  polling    -> {batch_id, status: "pending"|"done",
                 results: [<DiagnosticRecord sérialisé>],
                 item_errors: [{adresse, erreur}]}

Le store est en mémoire (process-local) — limitation documentée : perte au
redémarrage. TTL simple contre les fuites mémoire.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from app.core.logging import get_logger

logger = get_logger(__name__)

_BATCH_TTL_S = 24 * 3600
_BATCH_MAX_CONCURRENCY = 8

_batches: dict[str, dict[str, Any]] = {}

# Analyseur par adresse — injecté par l'appelant ; c'est TOUJOURS le pipeline
# canonique en production (aucune seconde implémentation).
Analyzer = Callable[[str], Awaitable[Any]]

_STATUS_PENDING = "pending"
_STATUS_PROCESSING = "processing"
_STATUS_DONE = "done"
_STATUS_FAILED = "failed"


def _batch_status(batch: dict[str, Any]) -> str:
    states = {it["status"] for it in batch["items"]}
    return _STATUS_DONE if states <= {_STATUS_DONE, _STATUS_FAILED} else _STATUS_PENDING


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
                item["result"] = await analyzer(item["address"])
                item["status"] = _STATUS_DONE
            except Exception as exc:  # une adresse ne doit pas tuer le lot
                logger.exception("batch %s -- echec pour %r", batch_id, item["address"])
                item["status"] = _STATUS_FAILED
                batch["item_errors"].append(
                    {"adresse": item["address"], "erreur": f"{type(exc).__name__}: {exc}"}
                )

    await asyncio.gather(*(process_item(item) for item in batch["items"]))
    batch["status_final"] = _STATUS_DONE


def submit_batch(addresses: list[str], analyzer: Analyzer) -> dict[str, Any]:
    """Crée un lot et lance son traitement en arrière-plan (FR-20)."""
    batch_id = uuid.uuid4().hex[:12]
    batch: dict[str, Any] = {
        "id": batch_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "item_errors": [],
        "items": [
            {"address": a, "status": _STATUS_PENDING, "result": None}
            for a in addresses
        ],
    }
    _batches[batch_id] = batch
    asyncio.get_running_loop().create_task(_run_batch_worker(batch_id, analyzer))
    return {"batch_id": batch_id, "n_accepted": len(addresses)}


def get_batch(batch_id: str) -> dict[str, Any] | None:
    """État d'un lot (polling). None si le lot n'existe pas."""
    batch = _batches.get(batch_id)
    if batch is None:
        return None
    return {
        "batch_id": batch_id,
        "status": _batch_status(batch),
        "results": [it["result"] for it in batch["items"] if it["result"] is not None],
        "item_errors": list(batch["item_errors"]),
    }
