"""
Tests unitaires pour la résolution per-building WFS (georisques_wfs.py).

Pas d'appels réseau : on fige des échantillons GML 3.2 réels (capturés sur le
service) et on vérifie le parsing + les tests géométriques point-in-polygon /
proximité — la partie qui décide « ce bâtiment est-il dans la zone ? ».
"""

from __future__ import annotations

import pytest

from app.connectors.georisques_wfs import (
    geometry_intersects_point,
    parse_gml_features,
    point_in_polygon,
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
