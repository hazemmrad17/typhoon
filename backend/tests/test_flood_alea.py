"""Tests offline du connecteur d'aléa d'inondation TRI (Directive Inondation).

Le connecteur lit les couches ISO_HT_* du WFS Géorisques (cartographie TRI) :
pour un point, il retourne par scénario (fréquent / moyen / extrême / faible)
la classe de hauteur d'eau officielle [ht_min, ht_max[ m dans laquelle tombe
le point. Payloads GML volontairement minimaux — les vrais portent
`srsDimension="2"` et des posList (lat, lon) sous srsName urn EPSG::4326.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi.testclient import TestClient

from app.connectors import flood_alea
from app.main import app

client = TestClient(app)


# ---------------------------------------------------------------------------
# Fixtures GML
# ---------------------------------------------------------------------------

def _feature(scenario: str, ht_min: str, ht_max: str, ring: str, datsortie: str = "") -> str:
    """Un membre ISO_HT avec anneau (lat, lon)."""
    ds = f"<ms:datsortie>{datsortie}</ms:datsortie>" if datsortie else ""
    return f"""<wfs:member>
      <ms:ISO_HT_XX_XX_XXX_FXX>
        <ms:msGeometry>
          <gml:Polygon srsName="urn:ogc:def:crs:EPSG::4326" srsDimension="2">
            <gml:exterior><gml:LinearRing>
              <gml:posList>{ring} {ring.split()[0]} {ring.split()[1]}</gml:posList>
            </gml:LinearRing></gml:exterior>
          </gml:Polygon>
        </ms:msGeometry>
        <ms:id>3039284</ms:id>
        <ms:id_zone>ZCH_23439</ms:id_zone>
        <ms:id_s_inond>SIN_715</ms:id_s_inond>
        <ms:typ_inond>01</ms:typ_inond>
        <ms:scenario>{scenario}</ms:scenario>
        <ms:datentree>2021-03-05</ms:datentree>{ds}
        <ms:ht_min>{ht_min}</ms:ht_min>
        <ms:ht_max>{ht_max}</ms:ht_max>
        <ms:cours_deau>loup</ms:cours_deau>
        <ms:id_tri>FR05201</ms:id_tri>
      </ms:ISO_HT_XX_XX_XXX_FXX>
    </wfs:member>"""


def _gml(*features: str) -> str:
    """GetFeature minimal : une FeatureCollection avec 1..n membres — comme la
    requête réelle qui joint 11 couches et mélange leurs polygones."""
    return f"""<?xml version='1.0' encoding="UTF-8" ?>
<wfs:FeatureCollection
   xmlns:ms="http://mapserver.gis.umn.edu/mapserver"
   xmlns:gml="http://www.opengis.net/gml/3.2"
   xmlns:wfs="http://www.opengis.net/wfs/2.0">
    {''.join(features)}
</wfs:FeatureCollection>"""


def _envelope_gml(ring: str) -> str:
    """Un membre `ms:LIMITETRI_FXX` — le PÉRIMÈTRE du TRI, sans ht_min/ht_max
    (c'est ce qui le distingue d'une classe de hauteur)."""
    return f"""<?xml version='1.0' encoding="UTF-8" ?>
<wfs:FeatureCollection
   xmlns:ms="http://mapserver.gis.umn.edu/mapserver"
   xmlns:gml="http://www.opengis.net/gml/3.2"
   xmlns:wfs="http://www.opengis.net/wfs/2.0">
  <wfs:member>
    <ms:LIMITETRI_FXX>
      <ms:msGeometry>
        <gml:MultiSurface srsName="urn:ogc:def:crs:EPSG::4326" srsDimension="2">
          <gml:surfaceMember>
            <gml:Polygon srsDimension="2">
              <gml:exterior><gml:LinearRing>
                <gml:posList>{ring}</gml:posList>
              </gml:LinearRing></gml:exterior>
            </gml:Polygon>
          </gml:surfaceMember>
        </gml:MultiSurface>
      </ms:msGeometry>
      <ms:id_tri>FR05201</ms:id_tri>
    </ms:LIMITETRI_FXX>
  </wfs:member>
</wfs:FeatureCollection>"""


# Anneau autour de (7.20, 43.69) — posList en (lat, lon) ; ~±0.01°
RING = "43.68 7.19 43.68 7.21 43.70 7.21 43.70 7.19"


# ---------------------------------------------------------------------------
# Parse du payload GML → zones TRI
# ---------------------------------------------------------------------------

def test_parse_iso_ht_multisurface_inherits_member_srs() -> None:
    """Cas réel ISO_HT (mesuré 2026-09-14) : le srsName URN porte sur la
    MultiSurface (ou l'Envelope du membre), PAS sur chaque Polygon. Sans
    héritage, les posList (lat, lon) ne sont pas retournées et le
    point-in-polygon ne matche jamais — « hors TRI partout »."""
    ring = "48.85 2.34 48.85 2.35 48.86 2.35 48.86 2.34"
    xml = f"""<?xml version='1.0' encoding="UTF-8" ?>
<wfs:FeatureCollection xmlns:ms="http://mapserver.gis.umn.edu/mapserver"
   xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:wfs="http://www.opengis.net/wfs/2.0">
  <wfs:member>
    <ms:ISO_HT_01_02MOY_FXX>
      <ms:msGeometry>
        <gml:MultiSurface srsName="urn:ogc:def:crs:EPSG::4326" srsDimension="2">
          <gml:surfaceMember>
            <gml:Polygon srsDimension="2">
              <gml:exterior><gml:LinearRing>
                <gml:posList>{ring} 48.85 2.34</gml:posList>
              </gml:LinearRing></gml:exterior>
            </gml:Polygon>
          </gml:surfaceMember>
        </gml:MultiSurface>
      </ms:msGeometry>
      <ms:scenario>02Moy</ms:scenario>
      <ms:ht_min>0</ms:ht_min><ms:ht_max>1</ms:ht_max>
    </ms:ISO_HT_01_02MOY_FXX>
  </wfs:member>
</wfs:FeatureCollection>"""
    zones = flood_alea.parse_iso_ht(xml)
    assert len(zones) == 1
    geom = zones[0]["geometry"]
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    ring0 = polys[0][0]
    # Axes retournés : (lon, lat) — 2.34 < lon < 2.35 en tête
    assert 2.3 < ring0[0][0] < 2.4 and 48.8 < ring0[0][1] < 48.9


def test_parse_iso_ht_payload_extracts_band_and_scenario() -> None:
    xml = _gml(_feature("02Moy", "0.5", "1", RING))
    zones = flood_alea.parse_iso_ht(xml)
    assert len(zones) == 1
    z = zones[0]
    assert z["ht_min"] == 0.5
    assert z["ht_max"] == 1.0
    assert z["scenario"] == "02Moy"
    assert z["datsortie"] == ""
    assert z["cours_deau"] == "loup"
    # géométrie (lon, lat) — l'anneau doit contenir le point de test
    assert z["geometry"]["type"] == "Polygon"
    assert flood_alea.point_in_polygon((7.20, 43.69), z["geometry"]) is True


def test_parse_garbage_payload_returns_empty() -> None:
    assert flood_alea.parse_iso_ht("") == []
    assert flood_alea.parse_iso_ht("<not xml") == []
    assert flood_alea.parse_iso_ht("<wfs:FeatureCollection></wfs:FeatureCollection>") == []


# ---------------------------------------------------------------------------
# Sélection de bande au point
# ---------------------------------------------------------------------------

def _zone(scenario: str, ht_min: float, ht_max: float, datsortie: str = "") -> dict[str, Any]:
    return {
        "ht_min": ht_min,
        "ht_max": ht_max,
        "scenario": scenario,
        "datsortie": datsortie,
        "cours_deau": "loup",
        "id_tri": "FR05201",
        "id_zone": "ZCH_1",
        "geometry": {
            "type": "Polygon",
            "coordinates": [[(7.19, 43.68), (7.21, 43.68), (7.21, 43.70), (7.19, 43.70), (7.19, 43.68)]],
        },
    }


def test_point_in_zone_selects_band() -> None:
    zones = [_zone("02Moy", 0.5, 1.0)]
    hit = flood_alea.select_zone(zones, 43.69, 7.20)
    assert hit is not None
    assert hit["ht_min"] == 0.5 and hit["ht_max"] == 1.0


def test_point_outside_all_zones_returns_none() -> None:
    zones = [_zone("02Moy", 0.5, 1.0)]
    assert flood_alea.select_zone(zones, 48.0, 2.0) is None


def test_retired_zone_is_ignored() -> None:
    """Une zone sortie (datsortie non vide) n'est plus cartographiée : elle ne
    doit jamais être sélectionnée même si le point est dedans."""
    zones = [_zone("02Moy", 0.5, 1.0, datsortie="2024-01-01")]
    assert flood_alea.select_zone(zones, 43.69, 7.20) is None


def test_ambiguous_overlaps_keep_deepest_band() -> None:
    zones = [_zone("02Moy", 0.0, 0.5), _zone("02Moy", 0.5, 1.0)]
    hit = flood_alea.select_zone(zones, 43.69, 7.20)
    assert hit is not None and hit["ht_min"] == 0.5


# ---------------------------------------------------------------------------
# Scénarios officiels
# ---------------------------------------------------------------------------

def test_scenario_keys_map_to_layers() -> None:
    # 4 requêtes par groupe de scénario (les polygones 04Fai noient un cap de
    # features dans une requête unique — mesuré en direct à Avignon).
    assert set(flood_alea.SCENARIO_QUERY) == set(flood_alea.SCENARIO_KEYS)
    for layers in flood_alea.SCENARIO_QUERY.values():
        assert layers
        assert all(layer.startswith("ms:ISO_HT_") for layer in layers)
    # 11 couches méropole uniques : typ 01 (4 classes) + typ 02 (3, pas de
    # 03MCC) + typ 03 (4) — vérifié sur le GetCapabilities live (2026-09-14).
    assert len({layer for layers_ in flood_alea.SCENARIO_QUERY.values() for layer in layers_}) == 11


def test_scenario_from_scenario_attr() -> None:
    assert flood_alea.scenario_key_of("01Fre") == "frequent"
    assert flood_alea.scenario_key_of("02Moy") == "moyen"
    assert flood_alea.scenario_key_of("03Ext") == "extreme"
    assert flood_alea.scenario_key_of("04Fai") == "faiable"
    assert flood_alea.scenario_key_of("peu-importe") is None


def test_scenario_from_scenario_attr_codes_observed_live() -> None:
    """Codes réellement servis par le WFS à Paris (mesuré 2026-09-14) :
    « 01For » sur les couches fréquentes, « 03Mcc » sur les extrêmes."""
    assert flood_alea.scenario_key_of("01For") == "frequent"
    assert flood_alea.scenario_key_of("03Mcc") == "extreme"
    assert flood_alea.scenario_key_of("02moy") == "moyen"  # casse libre


# ---------------------------------------------------------------------------
# Résolution au point (client httpx mocké)
# ---------------------------------------------------------------------------

class _FakeResponse:
    def __init__(self, text: str) -> None:
        self.text = text
        self.status_code = 200

    def raise_for_status(self) -> None:
        pass


class _FakeClient:
    """Chaque sous-chaîne de TYPENAMES reçoit son propre payload GML."""

    def __init__(self, payloads: dict[str, str]) -> None:
        self.payloads = payloads
        self.calls: list[str] = []
        self.params: list[dict[str, str]] = []

    async def get(self, url: str, params: dict[str, str] | None = None, timeout: float = 8.0) -> _FakeResponse:
        assert params is not None
        typenames = params["TYPENAMES"]
        self.calls.append(typenames)
        self.params.append(dict(params))
        for key, text in self.payloads.items():
            if key in typenames:
                return _FakeResponse(text)
        return _FakeResponse(
            "<wfs:FeatureCollection xmlns:wfs='http://www.opengis.net/wfs/2.0'></wfs:FeatureCollection>"
        )


async def test_resolve_flood_alea_hit_moyen() -> None:
    # Une requête par groupe de scénario (4 requêtes) ; chaque payload est un
    # mélange de polygones dont le scénario réel est relu dans l'attribut.
    fake = _FakeClient(
        {
            "01_02MOY_FXX": _gml(_feature("02Moy", "0.5", "1", RING)),
            "01_01FOR_FXX": _gml(_feature("01Fre", "0", "0.5", RING)),
        }
    )
    out = await flood_alea.resolve_flood_alea(43.69, 7.20, client=fake)  # type: ignore[arg-type]
    assert out["available"] is True
    assert out["resolution"] == "per-building"
    scen = {s["key"]: s for s in out["scenarios"]}
    assert scen["moyen"]["present"] is True
    assert scen["moyen"]["depth_band"]["min_m"] == 0.5
    assert scen["moyen"]["depth_band"]["max_m"] == 1.0
    assert scen["frequent"]["present"] is True
    assert scen["extreme"]["present"] is False
    # 4 requêtes distinctes : un par groupe de scénario (jamais une requête
    # unique — les polygones 04Fai noient les autres scénarios sous le cap).
    # Les groupes vides rejouent une fois (hoquet 200-vide du service) : le
    # nombre brut d'appels peut donc dépasser 4, jamais le nombre de requêtes.
    assert len(set(fake.calls)) == 4


async def test_resolve_retries_on_silent_empty_response() -> None:
    """Le service répond parfois HTTP 200 avec 0 feature pour une requête qui
    marchait une minute avant (mesuré en direct). Une première réponse vide
    doit être rejouée, pas conclue « present=False »."""

    class _FlakyClient:
        def __init__(self) -> None:
            self.calls = 0

        async def get(self, url: str, params: dict[str, str] | None = None, timeout: float = 8.0) -> _FakeResponse:
            assert params is not None
            self.calls += 1
            if "01_02MOY_FXX" in params["TYPENAMES"] and self.calls <= 1:
                return _FakeResponse(
                    "<wfs:FeatureCollection xmlns:wfs='http://www.opengis.net/wfs/2.0'></wfs:FeatureCollection>"
                )
            if "01_02MOY_FXX" in params["TYPENAMES"]:
                return _FakeResponse(_gml(_feature("02Moy", "0.5", "1", RING)))
            return _FakeResponse(
                "<wfs:FeatureCollection xmlns:wfs='http://www.opengis.net/wfs/2.0'></wfs:FeatureCollection>"
            )

    flaky = _FlakyClient()
    out = await flood_alea.resolve_flood_alea(43.69, 7.20, client=flaky)  # type: ignore[arg-type]
    scen = {s["key"]: s for s in out["scenarios"]}
    assert scen["moyen"]["present"] is True
    assert scen["moyen"]["depth_band"]["min_m"] == 0.5


async def test_resolve_flood_alea_open_band_sentinel_becomes_null() -> None:
    fake = _FakeClient({"ISO_HT": _gml(_feature("04Fai", "2", "9999", RING))})
    out = await flood_alea.resolve_flood_alea(43.69, 7.20, client=fake)  # type: ignore[arg-type]
    scen = {s["key"]: s for s in out["scenarios"]}
    assert scen["faiable"]["present"] is True
    assert scen["faiable"]["depth_band"]["min_m"] == 2.0
    assert scen["faiable"]["depth_band"]["max_m"] is None
    assert "≥" in scen["faiable"]["depth_band"]["label"]


async def test_resolve_flood_alea_no_zone_is_available_false() -> None:
    fake = _FakeClient({})
    out = await flood_alea.resolve_flood_alea(43.69, 7.20, client=fake)  # type: ignore[arg-type]
    assert out["available"] is False
    assert out["reason"]
    assert all(s["present"] is False for s in out["scenarios"])


async def test_resolve_flood_alea_service_down_never_raises() -> None:
    class _Down:
        async def get(self, url: str, params: dict[str, str] | None = None, timeout: float = 8.0) -> _FakeResponse:
            raise TimeoutError("boom")

    out = await flood_alea.resolve_flood_alea(43.69, 7.20, client=_Down())  # type: ignore[arg-type]
    assert out["available"] is False
    assert "indisponible" in out["reason"]
    assert all(s["present"] is None for s in out["scenarios"])


# ---------------------------------------------------------------------------
# Route HTTP
# ---------------------------------------------------------------------------

def test_route_flood_alea_contract(monkeypatch: Any) -> None:
    async def fake_resolve(lat: float, lon: float, **_: Any) -> dict[str, Any]:
        return json.loads(json.dumps({
            "available": True,
            "reason": None,
            "in_tri": True,
            "resolution": "per-building",
            "scenarios": [
                {"key": "frequent", "label": "Fréquent (~10 ans)", "present": True,
                 "depth_band": {"min_m": 0.0, "max_m": 0.5, "label": "0 – 0,5 m"},
                 "cours_deau": "loup", "id_tri": "FR05201"},
                {"key": "moyen", "label": "Moyen (~100 ans)", "present": False,
                 "depth_band": None, "cours_deau": None, "id_tri": None},
                {"key": "extreme", "label": "Extrême (~500 ans)", "present": False,
                 "depth_band": None, "cours_deau": None, "id_tri": None},
                {"key": "faiable", "label": "Faible (scénario faible)", "present": False,
                 "depth_band": None, "cours_deau": None, "id_tri": None},
            ],
            "source": flood_alea.SOURCE_NAME,
            "source_url": flood_alea.SOURCE_URL,
            "retrieved_at": "2026-09-14T00:00:00+00:00",
        }))

    monkeypatch.setattr(flood_alea, "resolve_flood_alea", fake_resolve)
    resp = client.get("/api/flood-alea?lat=43.69&lon=7.20")
    assert resp.status_code == 200
    body = resp.json()
    assert body["available"] is True
    assert body["in_tri"] is True
    assert body["scenarios"][0]["depth_band"]["min_m"] == 0.0
    assert body["source"] == flood_alea.SOURCE_NAME


def test_route_flood_alea_missing_params_422() -> None:
    assert client.get("/api/flood-alea").status_code == 422


# ---------------------------------------------------------------------------
# BBOX à l'échelle du POINT — la troncature du cap `count`
#
# Mesuré en direct (2026-09-14) sur un quai de Nantes : une boîte de quartier
# (±0,02°) avec count=400 est remplie par des polygones 2 km plus loin, donc le
# polygone couvrant RÉELLEMENT le point n'est jamais dans la page → « hors
# TRI » sur un quai. La même requête à l'échelle du point (±55 m) rend la
# bonne classe. Tout polygone contenant le point coupe une boîte centrée sur
# lui, si petite soit-elle : réduire ne perd aucun résultat utile.
# ---------------------------------------------------------------------------

async def test_resolve_flood_alea_bbox_is_point_sized() -> None:
    fake = _FakeClient({"01_02MOY_FXX": _gml(_feature("02Moy", "0.5", "1", RING))})
    await flood_alea.resolve_flood_alea(43.69, 7.20, client=fake)  # type: ignore[arg-type]
    assert fake.params
    for params in fake.params:
        south, west, north, east = (float(v) for v in params["BBOX"].split(",")[:4])
        # ~55 m de demi-côté : échelle du bâti, pas du quartier
        assert abs((north - south) - 2 * flood_alea.POINT_MARGIN_DEG) < 1e-9
        assert abs((east - west) - 2 * flood_alea.POINT_MARGIN_DEG) < 1e-9
        # la boîte contient bien le point demandé
        assert south <= 43.69 <= north and west <= 7.20 <= east
        # ordre d'axes URN EPSG::4326 = (lat, lon) — une BBOX lon-first
        # renverrait silencieusement 0 feature
        assert params["BBOX"].endswith("urn:ogc:def:crs:EPSG::4326")


def test_point_margin_stays_building_scale() -> None:
    """Garde-fou : si quelqu'un « élargit pour être sûr », la troncature du cap
    revient et les quais redeviendront faux."""
    assert flood_alea.POINT_MARGIN_DEG * 111_000 <= 100.0


# ---------------------------------------------------------------------------
# Deux absences différentes : « hors TRI » vs « dans un TRI, sans classe »
# ---------------------------------------------------------------------------

def test_envelope_layer_is_not_a_height_class() -> None:
    """`ms:LIMITETRI_FXX` n'a ni ht_min ni ht_max : la ranger dans
    SCENARIO_QUERY fabriquerait des classes de hauteur inexistantes."""
    assert flood_alea.TRI_ENVELOPE_LAYERS == ["ms:LIMITETRI_FXX"]
    flat = {layer for layers in flood_alea.SCENARIO_QUERY.values() for layer in layers}
    assert not flat & set(flood_alea.TRI_ENVELOPE_LAYERS)


def test_parse_iso_ht_ignores_bare_perimeter_feature() -> None:
    """Une feature de périmètre ne doit JAMAIS produire de zone de hauteur (le
    parseur de classes la rejette faute de ht_min/ht_max) — c'est pourquoi
    l'enveloppe passe par le parseur GML générique."""
    assert flood_alea.parse_iso_ht(_envelope_gml(RING)) == []


async def test_resolve_in_tri_without_class_is_not_hors_tri() -> None:
    """Mesuré : 3 quai du Châtelet (Orléans) et 10 quai Victor Augagneur (Lyon)
    rendaient « hors TRI » (aucune classe ne les couvre) alors que
    `ms:LIMITETRI_FXX` les couvre. Deux absences distinctes, deux messages."""
    fake = _FakeClient({"LIMITETRI": _envelope_gml(RING)})
    out = await flood_alea.resolve_flood_alea(43.69, 7.20, client=fake)  # type: ignore[arg-type]
    assert out["available"] is False
    assert out["in_tri"] is True
    assert "périmètre d'un TRI" in out["reason"]
    assert all(s["present"] is False for s in out["scenarios"])


async def test_resolve_envelope_empty_is_genuinely_hors_tri() -> None:
    fake = _FakeClient({})
    out = await flood_alea.resolve_flood_alea(43.69, 7.20, client=fake)  # type: ignore[arg-type]
    assert out["available"] is False
    assert out["in_tri"] is False
    assert "hors TRI" in out["reason"]


async def test_resolve_envelope_down_never_claims_hors_tri() -> None:
    """Une panne de la couche périmètre n'est pas une absence de TRI (§2 : une
    panne n'est jamais une absence de risque)."""

    class _EnvelopeDown(_FakeClient):
        async def get(self, url: str, params: dict[str, str] | None = None, timeout: float = 8.0) -> _FakeResponse:
            assert params is not None
            if "LIMITETRI" in params["TYPENAMES"]:
                raise TimeoutError("boom")
            return await super().get(url, params=params, timeout=timeout)

    out = await flood_alea.resolve_flood_alea(43.69, 7.20, client=_EnvelopeDown({}))  # type: ignore[arg-type]
    assert out["in_tri"] is None
    assert "n'a pas pu être vérifiée" in out["reason"]


async def test_resolve_class_hit_skips_envelope_query() -> None:
    """Si une classe existe au point, on ne va pas chercher le périmètre :
    une requête WFS en moins par diagnostic."""
    fake = _FakeClient({"01_02MOY_FXX": _gml(_feature("02Moy", "0.5", "1", RING))})
    out = await flood_alea.resolve_flood_alea(43.69, 7.20, client=fake)  # type: ignore[arg-type]
    assert out["available"] is True and out["in_tri"] is True
    assert not any("LIMITETRI" in c for c in fake.calls)
