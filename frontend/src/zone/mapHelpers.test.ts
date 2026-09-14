// @vitest-environment jsdom
//
// Régression : le WFS de l'IGN (BD TOPO) sert du GML en `srsDimension="3"`
// (triplets lat, lon, altitude) et place `srsName`/`srsDimension` sur l'élément
// GÉOMÉTRIE, jamais sur `posList` ni sur les `gml:LinearRing` imbriqués.
// L'ancien lecteur découpait par paires : le tracé d'un tronçon ressortait en
// 188 909 km (mesuré en direct) et un anneau de bassin versant se retrouvait en
// (lat, lon) inversé, donc TOUJOURS à l'extérieur du point testé.
import { describe, expect, it } from 'vitest';

import { gmlToGeoJson } from './mapHelpers';

const TRONCON = `<?xml version="1.0" encoding="UTF-8"?>
<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:BDTOPO_V3="http://BDTOPO_V3">
  <wfs:member>
    <BDTOPO_V3:troncon_hydrographique gml:id="troncon_hydrographique.733635">
      <BDTOPO_V3:cleabs>TRON_EAU0000002005079178</BDTOPO_V3:cleabs>
      <BDTOPO_V3:sens_de_l_ecoulement>Sens direct</BDTOPO_V3:sens_de_l_ecoulement>
      <BDTOPO_V3:geometrie>
        <gml:LineString srsName="urn:ogc:def:crs:EPSG::4326" srsDimension="3" gml:id="troncon_hydrographique.733635.geometrie">
          <gml:posList>48.84509117 2.359021 32 48.84506289 2.359114 32 48.84503455 2.35919611 31.9</gml:posList>
        </gml:LineString>
      </BDTOPO_V3:geometrie>
    </BDTOPO_V3:troncon_hydrographique>
  </wfs:member>
</wfs:FeatureCollection>`;

const BASSIN = `<?xml version="1.0" encoding="UTF-8"?>
<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:BDTOPO_V3="http://BDTOPO_V3">
  <wfs:member>
    <BDTOPO_V3:bassin_versant_topographique gml:id="bassin.1">
      <BDTOPO_V3:cleabs>BASSIN0000001</BDTOPO_V3:cleabs>
      <BDTOPO_V3:libelle_du_bassin_hydrographique>Seine-Normandie</BDTOPO_V3:libelle_du_bassin_hydrographique>
      <BDTOPO_V3:geometrie>
        <gml:Surface srsName="urn:ogc:def:crs:EPSG::4326" srsDimension="3" gml:id="bassin.1.geometrie">
          <gml:patches>
            <gml:PolygonPatch>
              <gml:exterior>
                <gml:LinearRing>
                  <gml:posList>48.90 2.30 30 48.90 2.40 30 48.80 2.40 30 48.80 2.30 30 48.90 2.30 30</gml:posList>
                </gml:LinearRing>
              </gml:exterior>
            </gml:PolygonPatch>
          </gml:patches>
        </gml:Surface>
      </BDTOPO_V3:geometrie>
    </BDTOPO_V3:bassin_versant_topographique>
  </wfs:member>
</wfs:FeatureCollection>`;

describe('gmlToGeoJson — GML 3D (BD TOPO / IGN)', () => {
  it('lit un posList en triplets et remet (lon, lat, altitude)', () => {
    const fc = gmlToGeoJson(TRONCON);
    expect(fc).not.toBeNull();
    const geom = fc!.features[0].geometry as GeoJSON.LineString;
    expect(geom.type).toBe('LineString');
    // 3 points, pas 4 : l'ancienne lecture par paires en produisait 4 tronqués.
    expect(geom.coordinates).toHaveLength(3);
    expect(geom.coordinates[0]).toEqual([2.359021, 48.84509117, 32]);
    expect(geom.coordinates[2]).toEqual([2.35919611, 48.84503455, 31.9]);
    // Contrôle de vraisemblance : France métropolitaine.
    for (const c of geom.coordinates) {
      expect(c[0]).toBeGreaterThan(-5);
      expect(c[0]).toBeLessThan(10);
      expect(c[1]).toBeGreaterThan(41);
      expect(c[1]).toBeLessThan(52);
    }
  });

  it('hérite srsName + srsDimension depuis gml:Surface vers le LinearRing nu', () => {
    const fc = gmlToGeoJson(BASSIN);
    expect(fc).not.toBeNull();
    const geom = fc!.features[0].geometry as GeoJSON.Polygon;
    const ring = geom.coordinates[0];
    expect(ring).toHaveLength(5);
    // Sans héritage, l'anneau ressortait en (48.9, 2.3) — donc inversé.
    expect(ring[0]).toEqual([2.3, 48.9, 30]);
    expect(ring[1]).toEqual([2.4, 48.9, 30]);
  });

  it('conserve les propriétés scalaires de la feature', () => {
    const fc = gmlToGeoJson(TRONCON);
    const props = fc!.features[0].properties as Record<string, string>;
    expect(props.cleabs).toBe('TRON_EAU0000002005079178');
    expect(props.sens_de_l_ecoulement).toBe('Sens direct');
  });
});
