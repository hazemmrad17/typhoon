"""
Tests unitaires pour la résolution per-building WFS (georisques_wfs.py).

Pas d'appels réseau : on fige des échantillons GML 3.2 réels (capturés sur le
service) et on vérifie le parsing + les tests géométriques point-in-polygon /
proximité — la partie qui décide « ce bâtiment est-il dans la zone ? ».
"""

from __future__ import annotations


from app.connectors import georisques_wfs
from app.connectors.georisques_wfs import (
    geometry_intersects_point,
    parse_gml_features,
    point_in_polygon,
    resolve_per_building,
)


# ---------------------------------------------------------------------------
# Échantillons GML 3.2 (extraits de réponses réelles du service)
# ---------------------------------------------------------------------------

GML_SAMPLE = """<?xml version='1.0' encoding="UTF-8" ?>
<wfs:FeatureCollection
   xmlns:ms="http://mapserver.gis.umn.edu/mapserver"
   xmlns:gml="http://www.opengis.net/gml/3.2"
   xmlns:wfs="http://www.opengis.net/wfs/2.0">
  <wfs:member>
    <ms:SSP_CLASSIF_SIS_GE gml:id="SIS.1">
      <ms:id_information>SIS123</ms:id_information>
      <ms:msGeometry>
        <gml:MultiSurface srsName="urn:ogc:def:crs:EPSG::4326">
          <gml:surfaceMember>
            <gml:Polygon>
              <gml:exterior>
                <gml:LinearRing>
                  <gml:posList>43.690 7.260 43.695 7.260 43.695 7.270 43.690 7.270 43.690 7.260</gml:posList>
                </gml:LinearRing>
              </gml:exterior>
            </gml:Polygon>
          </gml:surfaceMember>
        </gml:MultiSurface>
      </ms:msGeometry>
    </ms:SSP_CLASSIF_SIS_GE>
  </wfs:member>
  <wfs:member>
    <ms:C_GAZ gml:id="GAZ.1">
      <ms:msGeometry>
        <gml:LineString srsName="urn:ogc:def:crs:EPSG::4326">
          <gml:posList>43.690 7.270 43.695 7.270</gml:posList>
        </gml:LineString>
      </ms:msGeometry>
    </ms:C_GAZ>
  </wfs:member>
</wfs:FeatureCollection>
"""

# Le même polygone, mais avec un trou au centre (test des intérieurs).
GML_WITH_HOLE = """<?xml version='1.0' encoding="UTF-8" ?>
<wfs:FeatureCollection
   xmlns:ms="http://mapserver.gis.umn.edu/mapserver"
   xmlns:gml="http://www.opengis.net/gml/3.2"
   xmlns:wfs="http://www.opengis.net/wfs/2.0">
  <wfs:member>
    <ms:PPRN_PERIMETRE_INOND gml:id="PPR.1">
      <ms:msGeometry>
        <gml:Polygon srsName="urn:ogc:def:crs:EPSG::4326">
          <gml:exterior>
            <gml:LinearRing>
              <gml:posList>43.68 7.25 43.72 7.25 43.72 7.29 43.68 7.29 43.68 7.25</gml:posList>
            </gml:LinearRing>
          </gml:exterior>
          <gml:interior>
            <gml:LinearRing>
              <gml:posList>43.69 7.26 43.70 7.26 43.70 7.27 43.69 7.27 43.69 7.26</gml:posList>
            </gml:LinearRing>
          </gml:interior>
        </gml:Polygon>
      </ms:msGeometry>
    </ms:PPRN_PERIMETRE_INOND>
  </wfs:member>
</wfs:FeatureCollection>
"""


# ---------------------------------------------------------------------------
# Parsing GML
# ---------------------------------------------------------------------------

def test_parse_gml_features_multi_surface():
    feats = parse_gml_features(GML_SAMPLE)
    assert len(feats) == 2
    ssp = feats[0]
    assert ssp["type"] == "MultiPolygon"
    assert ssp["properties"]["id_information"] == "SIS123"
    gaz = feats[1]
    assert gaz["type"] == "LineString"
    assert len(gaz["coordinates"]) >= 2


def test_parse_gml_invalid_xml_returns_empty():
    assert parse_gml_features("<not xml") == []
    assert parse_gml_features("") == []
    assert parse_gml_features("<wfs:FeatureCollection/>") == []


def test_axis_order_lat_lon_swapped_to_lon_lat():
    """Le GML 3.2 avec URN EPSG:4326 stocke (lat, lon) — on doit renvoyer (lon, lat)."""
    feats = parse_gml_features(GML_SAMPLE)
    ring = feats[0]["coordinates"][0][0]
    lon, lat = ring[0]
    # posList commence par (43.690, 7.260) = (lat, lon) → renvoyé en (7.260, 43.690)
    assert abs(lon - 7.260) < 1e-6
    assert abs(lat - 43.690) < 1e-6


# ---------------------------------------------------------------------------
# Point-in-polygon
# ---------------------------------------------------------------------------

def test_point_inside_polygon():
    poly = {"type": "Polygon", "coordinates": [[(0, 0), (10, 0), (10, 10), (0, 10), (0, 0)]]}
    assert point_in_polygon((5, 5), poly) is True


def test_point_outside_polygon():
    poly = {"type": "Polygon", "coordinates": [[(0, 0), (10, 0), (10, 10), (0, 10), (0, 0)]]}
    assert point_in_polygon((50, 50), poly) is False


def test_point_in_hole_is_outside():
    feats = parse_gml_features(GML_WITH_HOLE)
    poly = feats[0]
    # Dans l'anneau extérieur mais dans le trou → hors zone
    assert geometry_intersects_point(poly, (7.265, 43.695)) is False
    # Dans l'anneau extérieur, hors du trou → dans la zone
    assert geometry_intersects_point(poly, (7.285, 43.685)) is True
    # Hors de tout → hors zone
    assert geometry_intersects_point(poly, (8.0, 44.0)) is False


def test_multipolygon_intersection():
    feats = parse_gml_features(GML_SAMPLE)
    ssp = feats[0]
    # Point au centre du polygone SIS → présent au bâtiment
    assert geometry_intersects_point(ssp, (7.265, 43.692)) is True
    # Point à l'extérieur → absent
    assert geometry_intersects_point(ssp, (7.5, 44.0)) is False


def test_line_proximity():
    feats = parse_gml_features(GML_SAMPLE)
    line = feats[1]
    # Point près de la ligne (même latitude, lon décalé de ~0.0005° ≈ 40 m) → présent
    assert geometry_intersects_point(line, (7.2705, 43.6925)) is True
    # Point très loin de la ligne → absent
    assert geometry_intersects_point(line, (8.0, 44.0)) is False


# ---------------------------------------------------------------------------
# resolve_per_building — ventilation "ppr_par_type" (correction de la
# conflation : un PPR sismique ne doit pas faire passer l'inondation en
# "per-building présent").
# ---------------------------------------------------------------------------

async def test_resolve_per_building_splits_ppr_by_type(monkeypatch):
    """Le point est dans un périmètre PPR sismique mais hors de tout périmètre
    PPR inondation. L'agrégat "ppr" (n'importe quel PPR) doit rester présent —
    comportement historique conservé pour la carte générale — mais la
    ventilation "ppr_par_type" doit distinguer les deux types, correctement.
    """
    seisme_ring = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0), (0.0, 0.0)]
    inond_ring = [(50.0, 50.0), (60.0, 50.0), (60.0, 60.0), (50.0, 60.0), (50.0, 50.0)]

    async def fake_fetch_wfs_layer(client, type_name, lon, lat, margin_deg=0.02, count=200):
        if type_name == "ms:PPRN_PERIMETRE_SEISME":
            return [{"type": "Polygon", "coordinates": [seisme_ring], "properties": {}}]
        if type_name in ("ms:PPRN_PERIMETRE_INOND", "ms:PPRN_PERIMETRE_SUBMAR"):
            return [{"type": "Polygon", "coordinates": [inond_ring], "properties": {}}]
        return []

    monkeypatch.setattr(georisques_wfs, "fetch_wfs_layer", fake_fetch_wfs_layer)

    # Point (5, 5) : dans le carré séisme, hors du carré inondation.
    resultat = await resolve_per_building(client=None, lon=5.0, lat=5.0)

    assert resultat["ppr"]["present"] is True
    assert resultat["ppr_par_type"]["seisme"]["present"] is True
    assert resultat["ppr_par_type"]["seisme"]["resolution"] == "per-building"
    assert resultat["ppr_par_type"]["inondation"]["present"] is False
    assert resultat["ppr_par_type"]["inondation"]["resolution"] == "per-building"
    assert resultat["ppr_par_type"]["mouvement_terrain"]["present"] is False


async def test_resolve_per_building_ppr_type_falls_back_when_wfs_unavailable(monkeypatch):
    async def failing_fetch_wfs_layer(client, type_name, lon, lat, margin_deg=0.02, count=200):
        return None

    monkeypatch.setattr(georisques_wfs, "fetch_wfs_layer", failing_fetch_wfs_layer)

    resultat = await resolve_per_building(client=None, lon=5.0, lat=5.0)

    assert resultat["ppr_par_type"]["inondation"] == {"present": None, "count": 0, "resolution": "commune-level"}


# ---------------------------------------------------------------------------
# parse_gml_features — variantes d'emboîtement MultiSurface réellement servies
# (Limites TRI) : `surfaceMembers` (pluriel, conteneur) et srsName URN porté
# par la MultiSurface sans répétition sur le Polygon. Sans ces deux branches,
# la couche ms:LIMITETRI_FXX ne rend rien ou reste en (lat, lon) → le test
# point-dans-périmètre répond « hors TRI » à tort (bug silencieux mesuré en
# qualification sur Paris, quai de Seine).
# ---------------------------------------------------------------------------

GML_SURFACE_MEMBERS_PLURAL = """<?xml version='1.0' encoding="UTF-8" ?>
<wfs:FeatureCollection
   xmlns:ms="http://mapserver.gis.umn.edu/mapserver"
   xmlns:gml="http://www.opengis.net/gml/3.2"
   xmlns:wfs="http://www.opengis.net/wfs/2.0">
  <wfs:member>
    <ms:LIMITETRI_FXX gml:id="TRI.1">
      <ms:msGeometry>
        <gml:MultiSurface srsName="urn:ogc:def:crs:EPSG::4326">
          <gml:surfaceMembers>
            <gml:Polygon>
              <gml:exterior>
                <gml:LinearRing>
                  <gml:posList>48.840 2.360 48.860 2.360 48.860 2.380 48.840 2.380 48.840 2.360</gml:posList>
                </gml:LinearRing>
              </gml:exterior>
            </gml:Polygon>
          </gml:surfaceMembers>
        </gml:MultiSurface>
      </ms:msGeometry>
    </ms:LIMITETRI_FXX>
  </wfs:member>
</wfs:FeatureCollection>"""


def test_parse_gml_features_surface_members_plural_with_inherited_srs():
    """`surfaceMembers` (pluriel) + srsName URN hérité de la MultiSurface :
    coordonnées (lon, lat) correctes et point-in-polygon qui matche."""
    feats = parse_gml_features(GML_SURFACE_MEMBERS_PLURAL)
    assert len(feats) == 1
    poly = feats[0]
    assert poly["type"] == "MultiPolygon"
    ring = list(poly["coordinates"][0][0])
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    # (lon, lat) : lon ∈ [2.36, 2.38], lat ∈ [48.84, 48.86]
    assert min(xs) == 2.36 and max(xs) == 2.38
    assert min(ys) == 48.84 and max(ys) == 48.86
    # Point quai de Seine (48.850, 2.370) DANS le périmètre
    assert point_in_polygon((2.370, 48.850), poly) is True
    assert point_in_polygon((3.0, 49.0), poly) is False
