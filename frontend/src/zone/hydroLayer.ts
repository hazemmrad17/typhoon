// =============================================================================
//   TYPHOON — /zone : couches cartographiques du « trajet de l'eau ».
//
//   Ce qui est dessiné ici est de la GÉOGRAPHIE RÉELLE : le tracé du cours
//   d'eau, son bassin versant contributeur et ses extrémités viennent du
//   réseau hydrographique IGN BD TOPO (cf. backend/app/connectors/hydro.py).
//   Aucune emprise n'est inventée : à la différence de l'ancienne surface
//   d'eau « à niveau », rien ne déborde du réseau réel.
//
//   Coût par image : seul le marqueur du trajet est une géométrie (un point) ;
//   la progression du tracé est une propriété de PEINTURE (`line-gradient`
//   masqué), pas une reconstruction de géométrie. C'est ce qui permet de faire
//   voler la caméra à 60 images/s sans faire ramer la carte.
// =============================================================================

import type mapboxgl from 'mapbox-gl';

import type { Journey } from './hydroRoute';

const BASIN_SRC = 'typhoon-hydro-basin-src';
const BASIN_FILL = 'typhoon-hydro-basin-fill';
const BASIN_LINE = 'typhoon-hydro-basin-line';

const ROUTE_SRC = 'typhoon-hydro-route-src';
const ROUTE_LINE = 'typhoon-hydro-route-line';
const ROUTE_DONE = 'typhoon-hydro-route-done';

const DROP_SRC = 'typhoon-hydro-drop-src';
const DROP = 'typhoon-hydro-drop';
const DROP_CORE = 'typhoon-hydro-drop-core';

const MARK_SRC = 'typhoon-hydro-mark-src';
const MARK_END = 'typhoon-hydro-mark-end';
const MARK_SITE = 'typhoon-hydro-mark-site';

const C_ROUTE = '#4d86c4';
const C_ROUTE_DONE = '#8fdcff';
const C_BASIN = '#1c4f8a';
const C_END = '#0b3d66';
const C_SITE = '#ffb703';
const C_DROP = '#eaf7ff';

export const HYDRO_LAYER_IDS = [DROP_CORE, DROP, MARK_SITE, MARK_END, ROUTE_DONE, ROUTE_LINE, BASIN_LINE, BASIN_FILL];

function emptyFc(): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

/** Une couche est « montée » dès lors que sa source existe. */
export function isJourneyMounted(map: mapboxgl.Map): boolean {
  return !!map.getSource(ROUTE_SRC);
}

function pointFc(lon: number, lat: number, props: Record<string, unknown> = {}): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lon, lat] } },
    ],
  };
}

/**
 * Monte les couches du trajet (idempotent). `site` = adresse diagnostiquée,
 * `origin`/`outlet` = extrémités réelles du parcours.
 */
export function mountJourney(
  map: mapboxgl.Map,
  journey: Journey,
  site: { lon: number; lat: number } | null,
  basinGeometry: GeoJSON.Geometry | null
): void {
  if (map.getSource(BASIN_SRC)) {
    (map.getSource(BASIN_SRC) as mapboxgl.GeoJSONSource).setData(
      basinGeometry
        ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: basinGeometry }] }
        : emptyFc()
    );
  } else {
    map.addSource(BASIN_SRC, {
      type: 'geojson',
      data: basinGeometry
        ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: basinGeometry }] }
        : emptyFc(),
    });
  }

  if (!map.getSource(ROUTE_SRC)) {
    map.addSource(ROUTE_SRC, {
      type: 'geojson',
      // `lineMetrics` est requis par `line-gradient` (progression peinte).
      lineMetrics: true,
      data: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: journey.coords.map((c) => [c[0], c[1]]) },
          },
        ],
      },
    });
  }

  if (!map.getSource(DROP_SRC)) map.addSource(DROP_SRC, { type: 'geojson', data: emptyFc() });
  if (!map.getSource(MARK_SRC)) {
    const marks: GeoJSON.Feature[] = [];
    const start = journey.coords[0];
    const end = journey.coords[journey.coords.length - 1];
    if (start) {
      marks.push({
        type: 'Feature',
        properties: { kind: 'origin' },
        geometry: { type: 'Point', coordinates: [start[0], start[1]] },
      });
    }
    if (end) {
      marks.push({
        type: 'Feature',
        properties: { kind: 'outlet' },
        geometry: { type: 'Point', coordinates: [end[0], end[1]] },
      });
    }
    if (site) {
      marks.push({
        type: 'Feature',
        properties: { kind: 'site' },
        geometry: { type: 'Point', coordinates: [site.lon, site.lat] },
      });
    }
    map.addSource(MARK_SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: marks } });
  }

  if (!map.getLayer(BASIN_FILL)) {
    map.addLayer({
      id: BASIN_FILL,
      type: 'fill',
      source: BASIN_SRC,
      paint: { 'fill-color': C_BASIN, 'fill-opacity': 0.07 },
    });
  }
  if (!map.getLayer(BASIN_LINE)) {
    map.addLayer({
      id: BASIN_LINE,
      type: 'line',
      source: BASIN_SRC,
      paint: { 'line-color': C_BASIN, 'line-width': 1.2, 'line-opacity': 0.5, 'line-dasharray': [4, 3] },
    });
  }
  if (!map.getLayer(ROUTE_LINE)) {
    map.addLayer({
      id: ROUTE_LINE,
      type: 'line',
      source: ROUTE_SRC,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': C_ROUTE, 'line-width': 3, 'line-opacity': 0.55, 'line-blur': 0.6 },
    });
  }
  if (!map.getLayer(ROUTE_DONE)) {
    map.addLayer({
      id: ROUTE_DONE,
      type: 'line',
      source: ROUTE_SRC,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': C_ROUTE_DONE,
        'line-width': 4.2,
        'line-opacity': 0.95,
        // Masque la totalité du tracé : la progression est révélée par peinture.
        'line-gradient': [
          'interpolate',
          ['linear'],
          ['line-progress'],
          0,
          C_ROUTE_DONE,
          0.001,
          C_ROUTE_DONE,
          0.002,
          'rgba(143,220,255,0)',
          1,
          'rgba(143,220,255,0)',
        ],
      },
    });
  }
  if (!map.getLayer(MARK_END)) {
    map.addLayer({
      id: MARK_END,
      type: 'circle',
      source: MARK_SRC,
      filter: ['!=', ['get', 'kind'], 'site'],
      paint: {
        'circle-radius': 4.5,
        'circle-color': C_END,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.6,
      },
    });
  }
  if (!map.getLayer(MARK_SITE)) {
    map.addLayer({
      id: MARK_SITE,
      type: 'circle',
      source: MARK_SRC,
      filter: ['==', ['get', 'kind'], 'site'],
      paint: {
        'circle-radius': 6,
        'circle-color': C_SITE,
        'circle-stroke-color': '#1b1b1b',
        'circle-stroke-width': 1.6,
      },
    });
  }
  if (!map.getLayer(DROP)) {
    map.addLayer({
      id: DROP,
      type: 'circle',
      source: DROP_SRC,
      paint: {
        'circle-radius': 11,
        'circle-color': C_ROUTE_DONE,
        'circle-opacity': 0.22,
      },
    });
  }
  if (!map.getLayer(DROP_CORE)) {
    map.addLayer({
      id: DROP_CORE,
      type: 'circle',
      source: DROP_SRC,
      paint: {
        'circle-radius': 4,
        'circle-color': C_DROP,
        'circle-stroke-color': C_ROUTE_DONE,
        'circle-stroke-width': 2,
      },
    });
  }

  setDrop(map, null);
  setProgress(map, 0);
}

/** Positionne le marqueur du trajet (géométrie : UN point, coût négligeable). */
export function setDrop(map: mapboxgl.Map, pos: { lon: number; lat: number } | null): void {
  const src = map.getSource(DROP_SRC) as mapboxgl.GeoJSONSource | undefined;
  if (!src) return;
  src.setData(pos ? pointFc(pos.lon, pos.lat) : emptyFc());
}

/**
 * Révèle le tracé jusqu'à `fraction` (0..1) — propriété de PEINTURE seulement.
 * Si la plateforme refuse `line-gradient` (source sans métriques de ligne), on
 * se contente du tracé complet : la marche reste lisible, rien ne casse.
 */
export function setProgress(map: mapboxgl.Map, fraction: number): void {
  if (!map.getLayer(ROUTE_DONE)) return;
  const f = Math.max(0, Math.min(1, fraction));
  try {
    map.setPaintProperty(ROUTE_DONE, 'line-gradient', [
      'interpolate',
      ['linear'],
      ['line-progress'],
      0,
      C_ROUTE_DONE,
      Math.max(0.0001, f),
      C_ROUTE_DONE,
      Math.min(1, f + 0.0015),
      'rgba(143,220,255,0)',
      1,
      'rgba(143,220,255,0)',
    ]);
  } catch {
    /* repli : tracé complet, aucune progression peinte */
  }
}

export function clearJourney(map: mapboxgl.Map): void {
  for (const id of [DROP_CORE, DROP, MARK_SITE, MARK_END, ROUTE_DONE, ROUTE_LINE, BASIN_LINE, BASIN_FILL]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  for (const src of [MARK_SRC, DROP_SRC, ROUTE_SRC, BASIN_SRC]) {
    if (map.getSource(src)) map.removeSource(src);
  }
}
