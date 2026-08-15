"""
Tests unitaires du batch Partner API (Phase 4B, item 24) — submit/poll.

Pas de réseau : `analyze_address` est mocké. On vérifie le contrat :
soumission -> polling -> statuts par adresse, une adresse en erreur ne tue
pas le lot, lot inconnu -> None (404 côté route).
"""

from __future__ import annotations

import asyncio

import pytest

import partner_api.service as svc
from partner_api.schemas import (
    Address,
    AnalyzeResponse,
    BatchItemStatus,
    Confidence,
    RiskPeriod,
)


@pytest.fixture(autouse=True)
def _clean_batches():
    svc._batches.clear()
    yield
    svc._batches.clear()


async def _fake_analyze(address: str, scenario: str = "rcp8_5") -> AnalyzeResponse:
    await asyncio.sleep(0.01)
    if "bad" in address:
        raise svc.AddressNotFound("adresse non trouvee")
    return AnalyzeResponse(
        adresse=Address(
            input=address, label=address, citycode="75056",
            postcode="75000", city="Paris", lat=48.85, lon=2.35,
        ),
        score_global=42,
        niveau_global="modere",
        confidence=Confidence(score=80, niveau="eleve", n_sources_disponibles=5, n_sources_total=5),
        zones={},
        risques_par_alea={},
        projection_2050=RiskPeriod(score_global=55, niveau_global="modere", zones={}, risques_par_alea={}),
        genere_le="2026-08-14",
    )


async def _wait_completed(batch_id: str, timeout: float = 2.0) -> svc.BatchPollResponse:
    elapsed = 0.0
    while elapsed < timeout:
        poll = svc.get_batch(batch_id)
        if poll and poll.status in ("completed", "failed"):
            return poll
        await asyncio.sleep(0.02)
        elapsed += 0.02
    raise AssertionError("le lot n'a pas termine a temps")


async def test_batch_submit_poll(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(svc, "analyze_address", _fake_analyze)
    submit = svc.submit_batch(["10 Rue Test Paris", "bad address", "20 Rue Test Paris"])
    assert submit.status == "queued"
    assert submit.total == 3

    poll = await _wait_completed(submit.batch_id)
    assert poll.status == "completed"
    assert poll.completed == 2
    assert poll.failed == 1

    by_address = {it.address: it for it in poll.items}
    assert by_address["10 Rue Test Paris"].status == BatchItemStatus.COMPLETED
    assert by_address["10 Rue Test Paris"].result.score_global == 42
    assert by_address["bad address"].status == BatchItemStatus.FAILED
    assert "non trouvee" in (by_address["bad address"].error or "")


async def test_batch_one_bad_address_does_not_kill_lot(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(svc, "analyze_address", _fake_analyze)
    submit = svc.submit_batch(["good address", "bad address"])
    poll = await _wait_completed(submit.batch_id)
    assert poll.status == "completed"
    assert poll.completed == 1
    assert poll.failed == 1


async def test_batch_unknown_returns_none():
    assert svc.get_batch("inconnu") is None
