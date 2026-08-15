"""
Tests de la route batch interne (Ticket 3 — insurerpagesplan).

POST /diagnostic/batch + GET /diagnostic/batch/{id} : meme contrat que la
Partner API /v1/batch, SANS cle d'API. L'analyseur est mocke (aucun reseau) :
on verifie la soumission, le polling, une adresse en erreur qui ne tue pas
le lot, et le 404 pour un lot inconnu.
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from app.services import batch as batch_service


@pytest.fixture(autouse=True)
def _clean_batches():
    batch_service._batches.clear()
    yield
    batch_service._batches.clear()


class _FakeAddressError(Exception):
    pass


async def _fake_analyzer(address: str, scenario: str = "rcp8_5"):
    await asyncio.sleep(0.005)
    if "bad" in address.lower():
        raise _FakeAddressError("adresse non trouvee")
    return {
        "adresse": {"input": address, "label": address, "citycode": "75056", "postcode": "75000", "city": "Paris", "lat": 48.85, "lon": 2.35},
        "score_global": 42,
        "niveau_global": "modere",
        "confidence": {"score": 80, "niveau": "eleve", "n_sources_disponibles": 5, "n_sources_total": 5},
        "zones": {},
        "risques_par_alea": {},
        "projection_2050": {"score_global": 55, "niveau_global": "modere", "zones": {}, "risques_par_alea": {}},
        "trajectoire": None,
        "erreurs_sources": [],
        "genere_le": "2026-08-14",
    }


def _wait_completed(batch_id: str, timeout: float = 3.0):
    import time

    elapsed = 0.0
    while elapsed < timeout:
        poll = batch_service.get_batch(batch_id)
        if poll and poll["status"] in ("completed", "failed"):
            return poll
        time.sleep(0.02)
        elapsed += 0.02
    raise AssertionError("le lot n'a pas termine a temps")


def test_internal_batch_submit_poll(monkeypatch: pytest.MonkeyPatch):
    from app.main import app

    original = batch_service.submit_batch

    def _submit_with_fake(addresses, analyzer=None, scenario="rcp8_5"):
        """Wrapper local : injecte l'analyseur factice (evite la recursion
        en appelant l'original capture, pas le nom patche)."""
        return original(addresses, analyzer=_fake_analyzer, scenario=scenario)

    monkeypatch.setattr(batch_service, "submit_batch", _submit_with_fake)

    with TestClient(app) as client:
        # Soumission sans cle d'API
        resp = client.post(
            "/diagnostic/batch",
            json={"addresses": ["10 Rue Test Paris", "bad address", "20 Rue Test Paris"], "scenario": "rcp8_5"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "queued"
        assert body["total"] == 3
        batch_id = body["batch_id"]

        # Polling jusqu'a completion
        poll = _wait_completed(batch_id)
        assert poll["status"] == "completed"
        assert poll["completed"] == 2
        assert poll["failed"] == 1

        by_address = {it["address"]: it for it in poll["items"]}
        assert by_address["10 Rue Test Paris"]["status"] == "completed"
        assert by_address["10 Rue Test Paris"]["result"]["score_global"] == 42
        assert by_address["bad address"]["status"] == "failed"
        assert "non trouvee" in (by_address["bad address"]["error"] or "")


def test_internal_batch_unknown_returns_404():
    from app.main import app

    with TestClient(app) as client:
        resp = client.get("/diagnostic/batch/inconnu")
        assert resp.status_code == 404
