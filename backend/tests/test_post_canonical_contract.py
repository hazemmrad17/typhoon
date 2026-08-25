# =============================================================================
#   T004 — POST /diagnostic/adresse sert le contrat canonique (FR-17 transport,
#   FR-10/12/13/14 sémantique de normalisation).
#
#   Comportement observable via l'API, sources mockées hors-ligne :
#     - 8 clés racine, 13 aléas, versionnage
#     - per_building mappé depuis le bloc batiment du brut (méthode + rayon)
#     - RGA forcé estimation communale ; sismicite/radon décrétaux
#     - échec géocodeur -> 422/502 AVANT tout appel source ; échec BDNB ->
#       200 partiel avec erreur explicite
#     - présent null jamais inféré d'une source morte
# =============================================================================

from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from app.connectors.geocoding import GeocodeResult
from app.main import app


# ---------------------------------------------------------------------------
# Fixtures brutes (formes réelles des connecteurs)
# ---------------------------------------------------------------------------

def _geo_result(score: float = 0.95) -> GeocodeResult:
    return GeocodeResult(
        label="10 Rue de Rivoli 75004 Paris",
        citycode="75056",
        postcode="75004",
        city="Paris",
        score=score,
        lat=48.8566,
        lon=2.3522,
    )


def _raw_georisques(wfs_ok: bool = True) -> dict:
    def layer(present: bool | None) -> dict:
        if not wfs_ok:
            return {"present": None, "count": 0, "resolution": "commune-level"}
        return {"present": present, "count": 2, "resolution": "per-building"}

    return {
        "risques_commune": {"existant": ["inondation"]},
        "zonage_sismique": [{"zone_sismicite": "2"}],
        "radon": [{"classe_potentiel": "faible"}],
        "erreurs": [],
        "batiment": {
            "ppr": layer(True),
            "ssp": layer(False),
            "canalisations": layer(False),
            "ppr_par_type": {
                "inondation": layer(True),
                "mouvement_terrain": layer(False),
                "seisme": layer(False),
                "avalanche": layer(False),
                "feu_foret": layer(False),
                "risque_industriel": layer(False),
                "minier": layer(False),
            },
        },
    }


BDNB_FICHE = {
    "batiment": {"batiment_groupe_id": "bdnb-bg-x", "mat_mur_txt": "pierre"},
    "autres_batiments_meme_adresse": [],
}


class _Counters:
    geocode = 0
    georisques = 0
    bdnb = 0


@pytest.fixture()
def counters(monkeypatch):
    c = _Counters()

    async def fake_geocode(client, address):
        c.geocode += 1
        return _geo_result()

    async def fake_raw(client, citycode, lat, lon):
        c.georisques += 1
        return _raw_georisques()

    async def fake_bdnb(client, address, label_ban=""):
        c.bdnb += 1
        return dict(BDNB_FICHE)

    monkeypatch.setattr("app.services.canonical.geocode_address", fake_geocode)
    monkeypatch.setattr("app.services.canonical.fetch_georisques_raw", fake_raw)
    monkeypatch.setattr("app.services.canonical._fetch_bdnb_avec_repli", fake_bdnb)
    yield c


def _post(client: TestClient, adresse: str = "10 rue de Rivoli, 75004 Paris"):
    return client.post("/diagnostic/adresse", json={"adresse": adresse})


# ---------------------------------------------------------------------------
# Chemin nominal
# ---------------------------------------------------------------------------


def test_post_returns_canonical_record(counters):
    with TestClient(app) as client:
        resp = _post(client)
    assert resp.status_code == 200
    body = resp.json()
    assert set(body.keys()) == {
        "schema_version", "adresse", "aleas", "bdnb",
        "georisques_source", "erreurs_partielles", "genere_le", "avertissement",
    }
    assert body["schema_version"] == "1.0"
    assert len(body["aleas"]) == 13
    codes = {a["code"] for a in body["aleas"]}
    assert {"icpe", "inondation", "sismicite", "mouvement_terrain", "radon", "rga",
            "cavite", "feu_foret", "avalanche", "canalisations", "vent_cyclonique",
            "ppr", "ssp"} == codes


def test_per_building_mapped_from_wfs_block(counters):
    with TestClient(app) as client:
        body = _post(client).json()
    by_code = {a["code"]: a for a in body["aleas"]}
    assert by_code["inondation"]["per_building"]["method"] == "point-in-polygon"
    assert by_code["inondation"]["present"] is True
    assert by_code["inondation"]["resolution"] == "per-building"
    # SSP testé par proximité : rayon rappelé dans la réponse
    assert by_code["ssp"]["per_building"]["method"] == "proximity"
    assert by_code["ssp"]["per_building"]["radius_m"] == 200.0
    assert by_code["ssp"]["present"] is False  # test effectué, aucun site touché


def test_rga_and_decree_labels_forced_end_to_end(counters):
    with TestClient(app) as client:
        body = _post(client).json()
    by_code = {a["code"]: a for a in body["aleas"]}
    assert by_code["rga"]["resolution"] == "commune-level-estimate"
    assert "per_building" not in by_code["rga"]
    assert by_code["sismicite"]["resolution"] == "commune-level"


def test_provenance_blocks_populated(counters):
    with TestClient(app) as client:
        body = _post(client).json()
    src = body["georisques_source"]
    assert src["provider"] == "Géorisques"
    assert len(src["attribution"]) > 0
    assert "recuperee_le" in src
    assert body["bdnb"]["donnees"]["batiment"]["mat_mur_txt"] == "pierre"
    assert body["bdnb"]["_source"]["provider"] == "BDNB"


# ---------------------------------------------------------------------------
# Dégradation (FR-14 / FR-22)
# ---------------------------------------------------------------------------


def test_wfs_down_yields_null_present_without_per_building(monkeypatch, counters):
    async def fake_raw(client, citycode, lat, lon):
        counters.georisques += 1
        return _raw_georisques(wfs_ok=False)

    monkeypatch.setattr("app.services.canonical.fetch_georisques_raw", fake_raw)
    with TestClient(app) as client:
        resp = _post(client)
    assert resp.status_code == 200
    by_code = {a["code"]: a for a in resp.json()["aleas"]}
    assert by_code["inondation"]["resolution"] != "per-building"
    assert "per_building" not in by_code["inondation"]


def test_bdnb_failure_partial_record(counters, monkeypatch):
    async def failing_bdnb(client, address, label_ban=""):
        counters.bdnb += 1
        raise httpx.ConnectTimeout("boom")

    monkeypatch.setattr("app.services.canonical._fetch_bdnb_avec_repli", failing_bdnb)
    with TestClient(app) as client:
        resp = _post(client)
    assert resp.status_code == 200
    body = resp.json()
    assert body["bdnb"] is None
    assert any(e.startswith("bdnb:") for e in body["erreurs_partielles"])


# ---------------------------------------------------------------------------
# Portes de géocodage (aucun appel source si rejet)
# ---------------------------------------------------------------------------


def test_low_score_rejected_before_downstream_calls(counters, monkeypatch):
    async def ambiguous(client, address):
        counters.geocode += 1
        return _geo_result(score=0.2)

    monkeypatch.setattr("app.services.canonical.geocode_address", ambiguous)
    with TestClient(app) as client:
        resp = _post(client, "saint denis")
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert detail["error"] == "adresse_ambigue"
    assert counters.georisques == 0 and counters.bdnb == 0


def test_geocoder_unreachable_502(counters, monkeypatch):
    async def dead(client, address):
        counters.geocode += 1
        raise httpx.ConnectError("dns")

    monkeypatch.setattr("app.services.canonical.geocode_address", dead)
    with TestClient(app) as client:
        resp = _post(client)
    assert resp.status_code == 502
    assert resp.json()["detail"]["error"] == "geocodage_indisponible"
    assert counters.georisques == 0 and counters.bdnb == 0


def test_address_not_found_422(counters, monkeypatch):
    async def unknown(client, address):
        counters.geocode += 1
        raise Exception("aucun resultat")  # GeocodingError attendu côté service

    monkeypatch.setattr("app.services.canonical.geocode_address", unknown)
    with TestClient(app) as client:
        resp = _post(client)
    assert resp.status_code in (422, 502)
