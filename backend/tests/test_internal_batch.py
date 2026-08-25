# =============================================================================
#   T005 — Batch = N × le pipeline canonique (FR-20)
#
#   Contrat spéc :
#     POST /diagnostic/batch        -> 200 {batch_id, n_accepted}
#     GET  /diagnostic/batch/{id}   -> {batch_id, status: pending|done,
#                                       results: [<DiagnosticRecord>],
#                                       item_errors: [{adresse, erreur}]}
#   Isolation : une adresse en échec ne tue jamais le lot.
# =============================================================================

from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.schemas.diagnostic_record import DiagnosticRecord


def _canned_record(adresse: str) -> dict:
    return {
        "schema_version": "1.0",
        "adresse": {"saisie": adresse, "normalisee": adresse.upper(),
                    "citycode": "75056", "postcode": "", "city": "",
                    "lat": 48.85, "lon": 2.35, "geocode_score": 0.9},
        "aleas": [{
            "code": "inondation", "libelle": "Inondation", "present": None,
            "present_commune": None, "zonage": None, "hauteur_eau_m": None,
            "zone_sismique": None, "catnat_historique": None,
            "source": "georisques", "url_detail": None, "erreur": None,
            "resolution": "commune-level-estimate",
        }],
        "bdnb": None,
        "georisques_source": {"provider": "Géorisques",
                              "url": "https://www.georisques.gouv.fr",
                              "attribution": "Source Géorisques — données à jour au 2026-07-01",
                              "recuperee_le": "2026-08-25T10:00:00+00:00"},
        "erreurs_partielles": [],
        "genere_le": "2026-08-25T10:00:01+00:00",
    }


def _record(adresse: str) -> DiagnosticRecord:
    return DiagnosticRecord.model_validate(_canned_record(adresse))


def _submit(client: TestClient, addresses: list[str]) -> dict:
    resp = client.post("/diagnostic/batch", json={"addresses": addresses})
    assert resp.status_code == 200, resp.text
    return resp.json()


def _poll_until_done(client: TestClient, batch_id: str, timeout_s: float = 10.0) -> dict:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        body = client.get(f"/diagnostic/batch/{batch_id}").json()
        if body["status"] == "done":
            return body
        time.sleep(0.05)
    raise TimeoutError("batch non terminé")


def test_batch_envelope_and_canonical_results(monkeypatch):
    async def fake_build(adresse: str) -> DiagnosticRecord:
        return _record(adresse)

    monkeypatch.setattr("app.api.routes.diagnostic.build_diagnostic_record", fake_build)

    with TestClient(app) as client:
        submitted = _submit(client, ["10 rue A", "10 rue B"])
        assert set(submitted.keys()) == {"batch_id", "n_accepted"}
        assert submitted["n_accepted"] == 2

        body = _poll_until_done(client, submitted["batch_id"])
    assert body["status"] == "done"
    assert len(body["results"]) == 2
    assert body["item_errors"] == []
    for r in body["results"]:
        assert r["schema_version"] == "1.0"
        assert len(r["aleas"]) == 1


def test_item_isolation_one_failure_never_kills_batch(monkeypatch):
    async def flaky(adresse: str) -> DiagnosticRecord:
        if "mauvaise" in adresse:
            raise ValueError("géocodeur introuvable")
        return _record(adresse)

    monkeypatch.setattr("app.api.routes.diagnostic.build_diagnostic_record", flaky)

    with TestClient(app) as client:
        submitted = _submit(client, ["bonne adresse 1", "mauvaise adresse", "bonne adresse 2"])
        body = _poll_until_done(client, submitted["batch_id"])

    assert len(body["results"]) == 2
    assert len(body["item_errors"]) == 1
    err = body["item_errors"][0]
    assert "mauvaise" in err["adresse"]
    assert "ValueError" in err["erreur"] or "introuvable" in err["erreur"]


def test_poll_unknown_id_404():
    with TestClient(app) as client:
        resp = client.get("/diagnostic/batch/inconnu")
    assert resp.status_code == 404
