"""Tests du « trajet de l'eau » (étape 2) — moteur de routage + météo.

Aucun réseau : `_get` / `_get_json` sont remplacés par des fixtures qui
reproduisent la FORME RÉELLE des réponses du WFS IGN (GML 3.2, `posList` en
triplets, `srsName`/`srsDimension` porté par l'élément géométrie) et de
l'API Open-Meteo.

Couvre les points de rupture identifiés en direct :
  · lecture 3D (`srsDimension="3"`) et ordre d'axes URN (lat, lon) ;
  · héritage de `srsName` vers les `gml:LinearRing` nus (bassin versant) ;
  · altitudes sentinelles « Pas de Z » (−1000) rejetées ;
  · parcours orienté par le sens d'écoulement, arrêt motivé (exutoire, source) ;
  · choix déterministe au branchement ;
  · contrat « ne casse jamais l'UI » : tout échec est typé, jamais levé.
"""

from __future__ import annotations

import pytest

import app.connectors.hydro as hydro
import app.connectors.meteo as meteo
from app.connectors.hydro import (
    Segment,
    _alt_at_end_nearest,
    _arrival,
    _coords_from_poslist,
    _pick,
    _point_in_ring,
    _profile,
    _ring_area_m2,
    _rings_of,
    _segment_from,
    _valid_z,
    _width_rank,
    build_hydro,
    extend_stretch,
    parse_features,
)
from xml.etree import ElementTree as ET

SITE_LAT, SITE_LON = 48.8505, 2.3500


# ---------------------------------------------------------------------------
# Fixtures GML
# ---------------------------------------------------------------------------

def _troncon(
    cleabs: str,
    ini: str | None,
    fin: str | None,
    coords: list[tuple[float, float, float]],
    *,
    sens: str = "Sens direct",
    principal: bool = True,
    largeur: str = "5 à 10 m",
    ordre: int = 4,
) -> str:
    pos = " ".join(f"{lat} {lon} {z}" for lat, lon, z in coords)
    return f"""
  <wfs:member>
    <BDTOPO_V3:troncon_hydrographique gml:id="{cleabs}">
      <BDTOPO_V3:cleabs>{cleabs}</BDTOPO_V3:cleabs>
      <BDTOPO_V3:sens_de_l_ecoulement>{sens}</BDTOPO_V3:sens_de_l_ecoulement>
      <BDTOPO_V3:codede_l_ecoulement/>
      <BDTOPO_V3:lien_vers_noeud_hydrographique_ini>{ini or ''}</BDTOPO_V3:lien_vers_noeud_hydrographique_ini>
      <BDTOPO_V3:lien_vers_noeud_hydrographique_fin>{fin or ''}</BDTOPO_V3:lien_vers_noeud_hydrographique_fin>
      <BDTOPO_V3:reseau_principal_coulant>{'true' if principal else 'false'}</BDTOPO_V3:reseau_principal_coulant>
      <BDTOPO_V3:classe_de_largeur>{largeur}</BDTOPO_V3:classe_de_largeur>
      <BDTOPO_V3:numero_d_ordre>{ordre}</BDTOPO_V3:numero_d_ordre>
      <BDTOPO_V3:geometrie>
        <gml:LineString srsName="urn:ogc:def:crs:EPSG::4326" srsDimension="3" gml:id="{cleabs}.g">
          <gml:posList>{pos}</gml:posList>
        </gml:LineString>
      </BDTOPO_V3:geometrie>
    </BDTOPO_V3:troncon_hydrographique>
  </wfs:member>"""


def _wrap(members: str) -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" '
        'xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:BDTOPO_V3="http://BDTOPO_V3">'
        f"{members}</wfs:FeatureCollection>"
    )


# Réseau linéaire : site sur TRON_1 → NB → TRON_2 → NC (exutoire) ; amont NA (source).
TRON_1 = _troncon("TRON_1", "NA", "NB", [(48.8500, 2.3500, 30.0), (48.8540, 2.3500, 30.0)])
TRON_2 = _troncon("TRON_2", "NB", "NC", [(48.8540, 2.3500, 30.0), (48.8580, 2.3500, 29.0)])
SEGMENTS_XML = _wrap(TRON_1 + TRON_2)

NODES = {"NA": "Source", "NB": "Jonction linéaire", "NC": "Exutoire"}

BASSIN_XML = _wrap(
    """
  <wfs:member>
    <BDTOPO_V3:bassin_versant_topographique gml:id="b1">
      <BDTOPO_V3:cleabs>BASSIN_1</BDTOPO_V3:cleabs>
      <BDTOPO_V3:libelle_du_bassin_hydrographique>Seine-Normandie</BDTOPO_V3:libelle_du_bassin_hydrographique>
      <BDTOPO_V3:toponyme>La Seine du confluent de test</BDTOPO_V3:toponyme>
      <BDTOPO_V3:code_hydrographique>03B0000002</BDTOPO_V3:code_hydrographique>
      <BDTOPO_V3:geometrie>
        <gml:Surface srsName="urn:ogc:def:crs:EPSG::4326" srsDimension="3" gml:id="b1.g">
          <gml:patches>
            <gml:PolygonPatch>
              <gml:exterior>
                <gml:LinearRing>
                  <gml:posList>48.80 2.20 30 48.80 2.50 30 48.90 2.50 30 48.90 2.20 30 48.80 2.20 30</gml:posList>
                </gml:LinearRing>
              </gml:exterior>
            </gml:PolygonPatch>
          </gml:patches>
        </gml:Surface>
      </BDTOPO_V3:geometrie>
    </BDTOPO_V3:bassin_versant_topographique>
  </wfs:member>"""
)

COURS_XML = _wrap(
    """
  <wfs:member>
    <BDTOPO_V3:cours_d_eau gml:id="c1">
      <BDTOPO_V3:cleabs>COURDEAU_1</BDTOPO_V3:cleabs>
      <BDTOPO_V3:toponyme>La Seine de test</BDTOPO_V3:toponyme>
      <BDTOPO_V3:importance>5</BDTOPO_V3:importance>
      <BDTOPO_V3:geometrie>
        <gml:LineString srsName="urn:ogc:def:crs:EPSG::4326" srsDimension="3" gml:id="c1.g">
          <gml:posList>48.8502 2.3501 30 48.8542 2.3501 30</gml:posList>
        </gml:LineString>
      </BDTOPO_V3:geometrie>
    </BDTOPO_V3:cours_d_eau>
  </wfs:member>"""
)


def _node_xml(cleabs: str) -> str:
    cat = NODES.get(cleabs, "Jonction linéaire")
    return _wrap(
        f"""
  <wfs:member>
    <BDTOPO_V3:noeud_hydrographique gml:id="{cleabs}">
      <BDTOPO_V3:cleabs>{cleabs}</BDTOPO_V3:cleabs>
      <BDTOPO_V3:categorie>{cat}</BDTOPO_V3:categorie>
      <BDTOPO_V3:geometrie>
        <gml:Point srsName="urn:ogc:def:crs:EPSG::4326" srsDimension="3" gml:id="{cleabs}.g">
          <gml:pos>48.8540 2.3500 30</gml:pos>
        </gml:Point>
      </BDTOPO_V3:geometrie>
    </BDTOPO_V3:noeud_hydrographique>
  </wfs:member>"""
    )


def _fake_get_factory(calls: list[dict] | None = None, fail: bool = False):
    async def _fake_get(client, params):
        if calls is not None:
            calls.append(params)
        if fail:
            return None
        layer = params.get("TYPENAMES")
        if layer == hydro.LAYER_TRONCON:
            return SEGMENTS_XML
        if layer == hydro.LAYER_NOEUD:
            cql = params.get("CQL_FILTER", "")
            cleabs = cql.split("'")[1] if "'" in cql else ""
            return _node_xml(cleabs)
        if layer == hydro.LAYER_BASSIN:
            return BASSIN_XML
        if layer == hydro.LAYER_COURS:
            return COURS_XML
        return None

    return _fake_get


# ---------------------------------------------------------------------------
# Lecture GML
# ---------------------------------------------------------------------------

def test_poslist_triplets_et_ordre_axes():
    """`srsDimension="3"` + URN → triplets (lat, lon, z) remis en (lon, lat, z)."""
    el = ET.fromstring(
        '<gml:LineString xmlns:gml="http://www.opengis.net/gml/3.2" '
        'srsName="urn:ogc:def:crs:EPSG::4326" srsDimension="3">'
        "<gml:posList>48.84509117 2.359021 32 48.84506289 2.359114 32</gml:posList>"
        "</gml:LineString>"
    )
    pts = _coords_from_poslist(el)
    assert len(pts) == 2
    assert pts[0] == (2.359021, 48.84509117, 32.0)
    # L'ancienne lecture par paires produisait ici des coordonnées absurdes.
    for lon, lat, _ in pts:
        assert -5 < lon < 10 and 41 < lat < 52


def test_poslist_2d_sans_altitude():
    el = ET.fromstring(
        '<gml:LineString xmlns:gml="http://www.opengis.net/gml/3.2" '
        'srsName="urn:ogc:def:crs:EPSG::4326" srsDimension="2">'
        "<gml:posList>48.85 2.35 48.86 2.36</gml:posList>"
        "</gml:LineString>"
    )
    pts = _coords_from_poslist(el)
    assert pts == [(2.35, 48.85, None), (2.36, 48.86, None)]


def test_props_et_geometrie_du_troncon():
    feats = parse_features(SEGMENTS_XML)
    assert len(feats) == 2
    _, props, rings = feats[0]
    seg = _segment_from(props, rings)
    assert seg is not None
    assert seg.cleabs == "TRON_1"
    assert seg.sens == "Sens direct"
    assert seg.ini == "NA" and seg.fin == "NB"
    assert seg.principal is True
    assert seg.downstream_node() == "NB"
    assert seg.upstream_node() == "NA"
    assert len(seg.points) == 2
    assert 400 < seg.length_m() < 500  # 0,004° de latitude ≈ 445 m


def test_sens_inverse_est_orientable():
    props = {
        "cleabs": "X",
        "sens_de_l_ecoulement": "Sens inverse",
        "lien_vers_noeud_hydrographique_ini": "A",
        "lien_vers_noeud_hydrographique_fin": "B",
    }
    seg = _segment_from(props, [[(2.35, 48.85, None), (2.36, 48.86, None)]])
    assert seg is not None
    # Sens inverse : l'eau entre par `fin` et sort par `ini`.
    assert seg.upstream_node() == "B"
    assert seg.downstream_node() == "A"


def test_sens_non_renseigne_refuse_de_deviner():
    props = {
        "cleabs": "X",
        "sens_de_l_ecoulement": "Sans objet",
        "lien_vers_noeud_hydrographique_ini": "A",
        "lien_vers_noeud_hydrographique_fin": "B",
    }
    seg = _segment_from(props, [[(2.35, 48.85, None), (2.36, 48.86, None)]])
    assert seg is not None
    assert seg.routable is False
    assert seg.downstream_node() is None


def test_anneau_de_surface_herite_des_attributs_de_geometrie():
    """Régression : `srsName` est sur `gml:Surface`, pas sur le `LinearRing`."""
    feat = ET.fromstring(BASSIN_XML).find(".//{http://BDTOPO_V3}bassin_versant_topographique")
    assert feat is not None
    rings = _rings_of(feat)
    assert len(rings) == 1
    lon, lat, _ = rings[0][0]
    # Sans héritage, le premier point ressortait (48.8, 2.2) — inversé.
    assert (round(lon, 1), round(lat, 1)) == (2.2, 48.8)


def test_altitudes_sentinelles_rejetees():
    assert _valid_z(None) is None
    assert _valid_z(-1000.0) is None  # « Pas de Z » observé en direct
    assert _valid_z(9999.0) is None
    assert _valid_z(32.0) == 32.0


def test_profil_en_long_ignore_les_altitudes_absentes():
    pts = [(2.35, 48.85, 30.0), (2.35, 48.854, None), (2.35, 48.858, 28.0)]
    prof = _profile(pts, step_m=100)
    assert [p["z_m"] for p in prof] == [30.0, 28.0]
    assert prof[0]["km"] == 0
    assert prof[-1]["km"] > 0.8


# ---------------------------------------------------------------------------
# Choix au branchement
# ---------------------------------------------------------------------------

def _seg(cleabs: str, *, principal: bool, largeur: str, z: float, lat: float = 48.854) -> Segment:
    props = {
        "cleabs": cleabs,
        "sens_de_l_ecoulement": "Sens direct",
        "lien_vers_noeud_hydrographique_ini": "N",
        "lien_vers_noeud_hydrographique_fin": "M",
        "reseau_principal_coulant": "true" if principal else "false",
        "classe_de_largeur": largeur,
    }
    return _segment_from(props, [[(2.35, lat, z), (2.35, lat + 0.004, z)]])  # type: ignore[arg-type]


def test_choix_prefere_le_reseau_principal():
    wide_minor = _seg("MINOR_WIDE", principal=False, largeur="20 à 30 m", z=30.0)
    narrow_main = _seg("MAIN_NARROW", principal=True, largeur="1 à 2 m", z=30.0)
    picked = _pick([wide_minor, narrow_main], 30.0, 2.35, 48.854)
    assert picked.cleabs == "MAIN_NARROW"


def test_choix_prefere_le_bras_le_plus_large():
    narrow = _seg("NARROW", principal=True, largeur="1 à 2 m", z=30.0)
    wide = _seg("WIDE", principal=True, largeur="10 à 20 m", z=30.0)
    assert _pick([narrow, wide], 30.0, 2.35, 48.854).cleabs == "WIDE"


def test_choix_prefere_la_continuite_du_lit():
    low = _seg("LOW", principal=True, largeur="5 à 10 m", z=10.0)
    close = _seg("CLOSE", principal=True, largeur="5 à 10 m", z=31.0)
    assert _pick([low, close], 30.0, 2.35, 48.854).cleabs == "CLOSE"


def test_altitude_lue_a_l_extremite_de_raccordement():
    """Comparer la mauvaise extrémité compare deux altitudes sans rapport."""
    seg = _segment_from(
        {
            "cleabs": "S",
            "sens_de_l_ecoulement": "Sens direct",
            "reseau_principal_coulant": "true",
        },
        [[(2.35, 48.850, 30.0), (2.35, 48.860, 20.0)]],
    )
    assert seg is not None
    assert _alt_at_end_nearest(seg, 2.35, 48.8501) == 30.0
    assert _alt_at_end_nearest(seg, 2.35, 48.8599) == 20.0


def test_rang_de_largeur():
    assert _width_rank("5 à 10 m") == 10.0
    assert _width_rank("0 à 1 m") == 1.0
    assert _width_rank(None) == 0.0


# ---------------------------------------------------------------------------
# Géométrie
# ---------------------------------------------------------------------------

def test_point_dans_anneau_et_aire():
    ring = [(2.2, 48.8), (2.5, 48.8), (2.5, 48.9), (2.2, 48.9)]
    assert _point_in_ring(2.35, 48.85, ring) is True
    assert _point_in_ring(2.6, 48.85, ring) is False
    # 0,3° de longitude ≈ 22,0 km et 0,1° de latitude ≈ 11,1 km à 48,85° N
    # → ≈ 243 km² (l'échelle en longitude dépend bien du cosinus de la latitude).
    assert 230 < _ring_area_m2(ring) / 1e6 < 260


def test_temps_de_propagation_borne_et_etiquete():
    arr = _arrival(40_000)  # 40 km en amont
    assert arr is not None
    assert arr["max_hours"] > arr["min_hours"]
    assert round(arr["min_hours"], 1) == round(40000 / 2.5 / 3600, 1)
    assert "pas un modèle hydraulique" in arr["note"]
    assert _arrival(0) is None


# ---------------------------------------------------------------------------
# Parcours complet (réseau simulé)
# ---------------------------------------------------------------------------

@pytest.fixture
def offline(monkeypatch):
    calls: list[dict] = []
    monkeypatch.setattr(hydro, "_get", _fake_get_factory(calls))
    return calls


async def test_build_hydro_parcours_complet(offline):
    route = await build_hydro(SITE_LAT, SITE_LON, budget=10)

    assert route["unavailable_reason"] is None
    assert route["watercourse"] == "La Seine de test"
    assert route["snap_distance_m"] is not None and route["snap_distance_m"] < 100
    assert route["segments_nearby"] == 2

    down = route["downstream"]
    assert down is not None
    assert down["segments"] == 2
    assert down["stop"]["reason"] == "exutoire"
    assert down["has_more"] is False
    assert down["length_km"] > 0.4

    up = route["upstream"]
    assert up is not None
    assert up["segments"] == 1
    assert up["stop"]["reason"] == "source"

    # Géométrie publiée en (lon, lat) — jamais inversée.
    coord = down["geometry"]["coordinates"][0]
    assert 2.0 < coord[0] < 3.0 and 48.0 < coord[1] < 49.0

    assert route["arrival"] is not None
    assert route["arrival"]["min_hours"] < route["arrival"]["max_hours"]

    basin = route["basin"]
    assert basin is not None
    assert basin["libelle"] == "Seine-Normandie"
    assert basin["toponyme"] == "La Seine du confluent de test"
    assert len(basin["geometry"]["coordinates"][0]) == 5


async def test_build_hydro_profil_reel_sans_altitude_inventee(offline):
    route = await build_hydro(SITE_LAT, SITE_LON, budget=10)
    down = route["downstream"]
    assert down is not None
    zs = [p["z_m"] for p in down["profile"]]
    assert zs and all(-450 < z < 4900 for z in zs)
    # Le lit descend vers l'aval : 30 m puis 29 m.
    assert zs[0] == 30.0


async def test_build_hydro_reste_stable_quand_le_reseau_est_indisponible(monkeypatch):
    monkeypatch.setattr(hydro, "_get", _fake_get_factory(fail=True))
    route = await build_hydro(SITE_LAT, SITE_LON, budget=5)
    assert route["unavailable_reason"] == "no_network"
    assert route["downstream"] is None and route["upstream"] is None
    assert "aucun trajet" in (route["unavailable_label"] or "")


async def test_build_hydro_ne_leve_jamais(monkeypatch):
    class Boom:
        def __init__(self, *a, **k):
            raise RuntimeError("boom")

    monkeypatch.setattr(hydro.httpx, "AsyncClient", Boom)
    route = await build_hydro(SITE_LAT, SITE_LON, budget=5)
    assert route["unavailable_reason"] == "error"
    assert route["downstream"] is None


async def test_curseur_invalide_est_type_et_non_leve():
    res = await extend_stretch("pas-un-curseur", budget=5)
    assert res["stop"]["reason"] == "bad_cursor"
    assert res["segments"] == 0


async def test_extension_d_un_parcours_borne(monkeypatch):
    """Le curseur est auto-suffisant : il reprend au nœud et prolonge."""
    monkeypatch.setattr(hydro, "_get", _fake_get_factory())
    res = await extend_stretch("down|NB|30", budget=5)
    assert res["segments"] >= 1
    assert res["stop"]["reason"] == "exutoire"
    assert res["geometry"] is not None


# ---------------------------------------------------------------------------
# Météo de référence
# ---------------------------------------------------------------------------

async def test_meteo_parse_pluie_et_debit(monkeypatch):
    async def _fake_json(client, url, params):
        if "flood" in url:
            return {
                "elevation": 35.0,
                "daily_units": {"river_discharge": "m³/s"},
                "daily": {
                    "time": ["2026-09-12", "2026-09-13"],
                    "river_discharge": [1.23, 1.30],
                    "river_discharge_mean": [1.23, 1.26],
                    "river_discharge_max": [1.23, 2.14],
                },
            }
        return {
            "hourly": {
                "time": ["2026-09-12T00:00", "2026-09-12T01:00"],
                "precipitation": [0.0, 2.4],
            }
        }

    monkeypatch.setattr(meteo, "_get_json", _fake_json)
    data = await meteo.fetch_meteo(SITE_LAT, SITE_LON)

    assert data["unavailable_reason"] is None
    assert data["rain_total_mm"] == 2.4
    assert data["rain_peak_mm_h"] == 2.4
    assert data["dry"] is False
    assert len(data["rain_hourly"]) == 2
    assert data["discharge"]["current"] == 1.23
    assert data["discharge"]["peak"] == 2.14
    assert data["discharge"]["peak_date"] == "2026-09-13"


async def test_meteo_signale_une_journee_seche(monkeypatch):
    """Une prévision sèche est dite telle — on ne dessine pas une courbe plate
    qui laisserait croire à un événement."""

    async def _fake_json(client, url, params):
        if "flood" in url:
            return {"daily": {"time": [], "river_discharge": []}}
        return {"hourly": {"time": ["t"], "precipitation": [0.0]}}

    monkeypatch.setattr(meteo, "_get_json", _fake_json)
    data = await meteo.fetch_meteo(SITE_LAT, SITE_LON)
    assert data["dry"] is True
    assert data["rain_total_mm"] == 0.0


async def test_meteo_ne_leve_jamais(monkeypatch):
    async def _boom(client, url, params):
        return None

    monkeypatch.setattr(meteo, "_get_json", _boom)
    data = await meteo.fetch_meteo(SITE_LAT, SITE_LON)
    assert data["unavailable_reason"] == "unavailable"
    assert data["discharge"] is None
    assert data["rain_hourly"] == []
