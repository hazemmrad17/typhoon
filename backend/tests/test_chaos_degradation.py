# =============================================================================
#   T013 — Suite chaos : chaque source tuée indépendamment (FR-22 / FR-14)
#
#   Matrice {source} × {timeout, 500, vide/malformé} à travers le POST :
#     - toujours 200 avec enregistrement PARTIEL explicite
#     - jamais de 500, jamais de présent inféré depuis une source morte
#     - échec TOTAL Géorisques -> faits communaux dégradés (résolution
#       estimate), pas d'erreur fatale
# =============================================================================

from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.connectors.geocoding import GeocodeResult

BDNB_OK = {"batiment": {"x": 1}, "autres_batiments_meme_adresse": []}


def _geo():
    return GeocodeResult(label="R", citycode="75056", postcode="", city="P",
                         score=0.95, lat=48.85, lon=2.35)


@pytest.fixture()
def geocode_ok(monkeypatch):
    async def fake(client, address):
        return _geo()
    monkeypatch.setattr("app.services.canonical.geocode_address", fake)


KILL_MODES = {
    "timeout": lambda: httpx.ConnectTimeout("t"),
    "server_500": lambda: httpx.HTTPStatusError("500",
        request=httpx.Request("GET", "http://x"),
        response=httpx.Response(500)),
}


@pytest.mark.parametrize("mode", list(KILL_MODES.keys()))
def test_kill_bdnb_yields_partial_record(monkeypatch, geocode_ok, mode):
    factory = KILL_MODES[mode]

    async def dead_bdnb(client, address, label_ban=""):
        raise factory()

    async def ok_raw(client, cc, la, lo):
        return {"erreurs": [], "batiment": {}}

    monkeypatch.setattr("app.services.canonical._fetch_bdnb_avec_repli", dead_bdnb)
    monkeypatch.setattr("app.services.canonical.fetch_georisques_raw", ok_raw)

    with TestClient(app) as client:
        resp = client.post("/diagnostic/adresse", json={"adresse": "10 rue x"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["bdnb"] is None
    assert any(e.startswith("bdnb:") for e in body["erreurs_partielles"])
    assert len(body["aleas"]) == 13


@pytest.mark.parametrize("mode", list(KILL_MODES.keys()))
def test_kill_georisques_total_failure_degrades(monkeypatch, geocode_ok, mode):
    """Déviation résorbée : échec total -> 200 dégradé (plus de 502)."""
    factory = KILL_MODES[mode]

    async def dead_raw(client, cc, la, lo):
        raise factory()

    async def ok_bdnb(client, address, label_ban=""):
        return dict(BDNB_OK)

    monkeypatch.setattr("app.services.canonical.fetch_georisques_raw", dead_raw)
    monkeypatch.setattr("app.services.canonical._fetch_bdnb_avec_repli", ok_bdnb)

    with TestClient(app) as client:
        resp = client.post("/diagnostic/adresse", json={"adresse": "10 rue x"})
    assert resp.status_code == 200
    body = resp.json()
    assert any(e.startswith("georisques:") for e in body["erreurs_partielles"])
    by_code = {a["code"]: a for a in body["aleas"]}
    # aucun fait géométrique inféré : WFS mort -> présent null ou communal
    for code in ("inondation", "ppr", "ssp", "canalisations"):
        assert "per_building" not in by_code[code]
        assert by_code[code]["resolution"] != "per-building"
    # les décrétaux gardent leur résolution naturelle
    assert by_code["sismicite"]["resolution"] == "commune-level"


def test_malformed_bdnb_payload_is_not_a_500(monkeypatch, geocode_ok):
    """BDNB répond 200 mais un payload non-dict : contrat protégé, bloc null."""
    async def weird_bdnb(client, address, label_ban=""):
        return ["pas", "un", "dict"]

    async def ok_raw(client, cc, la, lo):
        return {"erreurs": [], "batiment": {}}

    monkeypatch.setattr("app.services.canonical._fetch_bdnb_avec_repli", weird_bdnb)
    monkeypatch.setattr("app.services.canonical.fetch_georisques_raw", ok_raw)

    with TestClient(app) as client:
        resp = client.post("/diagnostic/adresse", json={"adresse": "10 rue x"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["bdnb"] is None
    assert any(e.startswith("bdnb:") for e in body["erreurs_partielles"])


def test_never_inferred_present_on_killed_sources(monkeypatch, geocode_ok):
    """FR-14 propriétaire : aucune paire (present=true/false) ne peut provenir
    d'une source en échec."""
    async def dead_bdnb(client, address, label_ban=""):
        raise httpx.ConnectTimeout("t")

    async def dead_raw(client, cc, la, lo):
        raise httpx.ConnectTimeout("t")

    monkeypatch.setattr("app.services.canonical._fetch_bdnb_avec_repli", dead_bdnb)
    monkeypatch.setattr("app.services.canonical.fetch_georisques_raw", dead_raw)

    with TestClient(app) as client:
        resp = client.post("/diagnostic/adresse", json={"adresse": "10 rue x"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["bdnb"] is None
    for a in body["aleas"]:
        if a["erreur"]:
            assert a["present"] is None
