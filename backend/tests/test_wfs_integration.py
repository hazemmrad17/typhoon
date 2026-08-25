# =============================================================================
#   T007 — Intégration WFS & sémantique de résolution (FR-06..FR-09)
#
#   - parsing GML : ordre d'axes EPSG::4326 (lat,lon) vs legacy (lon,lat)
#   - géométrie : polygone avec trou
#   - ventilation ppr_par_type indépendante de l'agrégat
#   - WFS mort -> repli communal sans cascade sur le REST (client dédié FR-09)
# =============================================================================

from __future__ import annotations

import xml.etree.ElementTree as ET

import httpx
import pytest

from app.connectors import georisques as gg
from app.connectors.georisques_wfs import (
    _parse_poslist,
    geometry_intersects_point,
)


# ---------------------------------------------------------------------------
# GML — ordre des axes
# ---------------------------------------------------------------------------


def _poslist_el(srs: str | None, text: str) -> ET.Element:
    el = ET.Element("posList")
    if srs:
        el.set("srsName", srs)
    el.text = text
    return el


def test_gml_axis_order_urn_epsg4326_is_lat_lon():
    el = _poslist_el("urn:ogc:def:crs:EPSG::4326", "48.85 2.35 48.86 2.36")
    assert _parse_poslist(el) == [(2.35, 48.85), (2.36, 48.86)]


def test_gml_axis_order_legacy_is_lon_lat():
    el = _poslist_el("http://www.opengis.net/gml/srs/epsg.xml#4326", "2.35 48.85")
    assert _parse_poslist(el) == [(2.35, 48.85)]


def test_gml_axis_order_inherited_from_parent():
    parent_srs = "urn:ogc:def:crs:EPSG::4326"
    el = _poslist_el(None, "48.85 2.35")
    assert _parse_poslist(el, parent_srs) == [(2.35, 48.85)]


# ---------------------------------------------------------------------------
# Géométrie — polygone avec trou
# ---------------------------------------------------------------------------


def test_polygon_with_hole_excludes_inner_point():
    square = [[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0), (0.0, 0.0)]]
    hole = [[(4.0, 4.0), (6.0, 4.0), (6.0, 6.0), (4.0, 6.0), (4.0, 4.0)]]
    geom = {"type": "Polygon", "coordinates": [square[0], hole[0]]}
    assert geometry_intersects_point(geom, (1.0, 1.0)) is True
    assert geometry_intersects_point(geom, (5.0, 5.0)) is False


# ---------------------------------------------------------------------------
# ppr_par_type — ventilation indépendante (API canonique)
# ---------------------------------------------------------------------------


async def _canonical_from_batiment(batiment: dict):
    from fastapi.testclient import TestClient

    from app.main import app
    from app.services import canonical

    async def fake_geo(client, a):
        from app.connectors.geocoding import GeocodeResult
        return GeocodeResult(label="x", citycode="75056", postcode="", city="P",
                             score=0.95, lat=48.85, lon=2.35)

    async def fake_raw(client, cc, la, lo):
        return {"erreurs": [], "batiment": batiment}

    async def fake_bdnb(client, a, l=""):
        return None

    canonical.geocode_address = fake_geo
    canonical.fetch_georisques_raw = fake_raw
    canonical._fetch_bdnb_avec_repli = fake_bdnb

    with TestClient(app) as client:
        return client.post("/diagnostic/adresse", json={"adresse": "10 rue x"}).json()


@pytest.mark.asyncio
async def test_ppr_type_breakdown_independent():
    """Dans un périmètre inondation mais hors mouvement de terrain :
    l'agrégat ne doit pas masquer la nuance par péril."""
    def layer(present):
        return {"present": present, "count": 1, "resolution": "per-building"}

    body = await _canonical_from_batiment({
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
    })
    by_code = {a["code"]: a for a in body["aleas"]}
    assert by_code["inondation"]["present"] is True
    assert by_code["mouvement_terrain"]["present"] is False
    assert by_code["ppr"]["present"] is True
    assert by_code["inondation"]["resolution"] == "per-building"


# ---------------------------------------------------------------------------
# Client WFS dédié (FR-09) — pas de contamination REST <-> WFS
# ---------------------------------------------------------------------------


class _BrokenWFSClient:
    """Simule un client dont toutes les requêtes /services échouent."""

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return None

    async def get(self, *args, **kwargs):
        raise httpx.ConnectError("wfs down")


def _rest_mock_client(calls: list[str]) -> httpx.AsyncClient:
    def responder(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(200, json={"data": []})

    return httpx.AsyncClient(transport=httpx.MockTransport(responder))


@pytest.mark.asyncio
async def test_wfs_failure_degrades_without_breaking_rest(monkeypatch):
    """WFS injoignable -> batiment={}, le REST continue de répondre."""
    rest_calls: list[str] = []

    async def fake_fetch(client, citycode, lat, lon):
        # réimplémente le squelette : WFS isolé puis REST
        try:
            async with gg._new_wfs_client() as wfs_client:
                batiment = await gg.resolve_per_building(wfs_client, lon, lat)
        except Exception:
            batiment = {}
        raw = {"erreurs": [], "batiment": batiment}
        raw["gaspar"] = await _fake_rest()
        rest_calls.append("done")
        return raw

    async def _fake_rest():
        return {}

    monkeypatch.setattr(gg, "_new_wfs_client", lambda: _BrokenWFSClient())
    monkeypatch.setattr("app.services.canonical.fetch_georisques_raw", fake_fetch)

    body = await _canonical_from_batiment({})
    assert rest_calls == ["done"]
    by_code = {a["code"]: a for a in body["aleas"]}
    assert by_code["inondation"]["resolution"] != "per-building"
    assert by_code["sismicite"]["resolution"] == "commune-level"
