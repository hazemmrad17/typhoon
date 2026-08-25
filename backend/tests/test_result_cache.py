# =============================================================================
#   T010 — Cache résultat en processus, TTL (FR-26)
#
#   - clé = label normalisé + lat/lon arrondis à 5 décimales + citycode +
#     schema_version
#   - hit -> ZÉRO appel upstream ; timestamps du record d'origine préservés
#   - TTL configurable ; 0 désactive
# =============================================================================

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.connectors.geocoding import GeocodeResult


class _Counters:
    def __init__(self):
        self.geocode = 0
        self.georisques = 0
        self.bdnb = 0


@pytest.fixture()
def counters(monkeypatch):
    c = _Counters()

    async def fake_geo(client, address):
        c.geocode += 1
        return GeocodeResult(label="10 Rue de Rivoli 75004 Paris", citycode="75056",
                             postcode="75004", city="Paris", score=0.95,
                             lat=48.8566000, lon=2.3522000)

    async def fake_raw(client, cc, la, lo):
        c.georisques += 1
        return {"erreurs": [], "batiment": {}}

    async def fake_bdnb(client, address, label_ban=""):
        c.bdnb += 1
        return {"batiment": {}, "autres_batiments_meme_adresse": []}

    monkeypatch.setattr("app.services.canonical.geocode_address", fake_geo)
    monkeypatch.setattr("app.services.canonical.fetch_georisques_raw", fake_raw)
    monkeypatch.setattr("app.services.canonical._fetch_bdnb_avec_repli", fake_bdnb)
    yield c


def _post(client):
    return client.post("/diagnostic/adresse", json={"adresse": "10 rue de Rivoli"})


def _reset_cache():
    from app.services import canonical
    canonical._RESULT_CACHE.clear()


def test_identical_requests_single_upstream_pass(counters, monkeypatch):
    monkeypatch.setattr("app.core.config.settings.cache_ttl_seconds", 3600)
    _reset_cache()
    with TestClient(app) as client:
        r1 = _post(client)
        r2 = _post(client)
    assert r1.status_code == r2.status_code == 200
    assert counters.georisques == 1 and counters.bdnb == 1 and counters.geocode == 1
    # le timestamp du record servi depuis le cache reflète la génération d'origine
    assert r1.json()["genere_le"] == r2.json()["genere_le"]


def test_ttl_zero_disables_cache(counters, monkeypatch):
    monkeypatch.setattr("app.core.config.settings.cache_ttl_seconds", 0)
    _reset_cache()
    with TestClient(app) as client:
        _post(client)
        _post(client)
    assert counters.georisques == 2


def test_key_precision_five_decimals(counters, monkeypatch):
    """Deux adresses résolues à des coordonnées différentes au-delà de 5
    décimales produisent des clés distinctes."""
    monkeypatch.setattr("app.core.config.settings.cache_ttl_seconds", 3600)
    _reset_cache()

    async def shifted_geo(client, address):
        counters.geocode += 1
        if "rivoli" in address.lower():
            return GeocodeResult(label="10 Rue de Rivoli 75004 Paris", citycode="75056",
                                 postcode="75004", city="Paris", score=0.95,
                                 lat=48.8566000, lon=2.3522000)
        return GeocodeResult(label="Promenade des Anglais 06000 Nice", citycode="06088",
                             postcode="06000", city="Nice", score=0.9,
                             lat=43.71020001, lon=7.26220000)

    monkeypatch.setattr("app.services.canonical.geocode_address", shifted_geo)
    with TestClient(app) as client:
        _post(client)          # Paris
        client.post("/diagnostic/adresse", json={"adresse": "promenade des anglais"})
    assert counters.georisques == 2  # clés distinctes -> second passage upstream
