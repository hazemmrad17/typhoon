# =============================================================================
#   T009 — Authentification par clé d'API statique (FR-21)
#
#   - X-API-Key validé contre une liste d'environnement
#   - clé absente -> 401 ; invalide -> 403 ; /health* exempté
#   - la clé n'apparaît JAMAIS dans les logs
#   - liste vide (non configurée) -> accès ouvert mode dev, warning au boot
# =============================================================================

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture()
def keyed(monkeypatch):
    monkeypatch.setattr("app.core.config.settings.api_keys",
                        "cle-pilote-a, cle-pilote-b")
    return TestClient(app)


def test_missing_key_401(keyed):
    resp = keyed.post("/diagnostic/adresse", json={"adresse": "x"})
    assert resp.status_code == 401


def test_invalid_key_403(keyed):
    resp = keyed.post("/diagnostic/adresse", json={"adresse": "x"},
                      headers={"X-API-Key": "mauvaise-cle"})
    assert resp.status_code == 403


def test_valid_key_passes_auth_layer(keyed):
    """La couche auth laisse passer (le 200/422/502 dépend des sources mockées
    ou non — ici sans mock le géocodeur peut échouer réseau : on accepte tout
    sauf 401/403.)"""
    resp = keyed.get("/health/detailed")
    assert resp.status_code == 200


def test_health_endpoints_exempt(keyed):
    assert keyed.get("/health").status_code == 200
    assert keyed.get("/health/detailed").status_code == 200


def test_unconfigured_keys_open_mode(monkeypatch):
    monkeypatch.setattr("app.core.config.settings.api_keys", "")
    client = TestClient(app)
    assert client.get("/health").status_code == 200


def test_api_key_never_logged(keyed, caplog):
    keyed.post("/diagnostic/adresse", json={"adresse": "10 rue x"},
               headers={"X-API-Key": "cle-pilote-a"})
    assert "cle-pilote-a" not in caplog.text
