// =============================================================================
//   TYPHOON — Helpers cartographiques partagés (MapLibre / Mapbox)
//   Fonctions utilitaires partagées de la carte (ex-ZoneMap.tsx, désormais Mapbox)
//   dépendance cyclique après la migration vers Mapbox en moteur unique.
// =============================================================================

import proj4 from 'proj4';

import { WMS_BASE, WFS_BASE } from '../zone/config';

/* ── CRS / Laplace ── */

function firstCoord(node: unknown): [number, number] | null {
  if (!Array.isArray(node)) return null;
  if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') {
    return [node[0], node[1]];
  }
  for (const sub of node) {
    const c = firstCoord(sub);
    if (c) return c;
  }
  return null;
}

function mapCoords(
  node: unknown,
  fn: (x: number, y: number) => [number, number]
): unknown {
  if (!Array.isArray(node)) return node;
  if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') {
    const [x, y] = node as [number, number];
    return fn(x, y);
  }
  return node.map((n) => mapCoords(n, fn));
}

/* Définition Lambert-93 (EPSG:2154) pour proj4 — reprojecteur exact côté
   client. L'ancienne approximation maison (série trigonométrique) dérivait
   de ~10-100 m selon la position : le bâtiment surligné était décalé par
   rapport à l'empreinte Mapbox Standard (données WGS84 exactes). */
proj4.defs('EPSG:2154',
  '+proj=lcc +lat_1=49 +lat_2=44 +lat_0=46.5 +lon_0=3 +x_0=700000 +y_0=6600000 '
  + '+ellps=GRS80 +towgs84=0,0,0 +units=m +no_defs');
const L93_TO_WGS84 = proj4('EPSG:2154', 'EPSG:4326');

function lambert93ToWgs84(x: number, y: number): [number, number] {
  // Lambert-93 (RGF93) → WGS84 via proj4 (précision centimétrique).
  const [lon, lat] = L93_TO_WGS84.forward([x, y]) as [number, number];
  return [lon, lat];
}

/** Convertit une géométrie BDNB (Lambert-93 → WGS84 si nécessaire). */
export function geomToWgs84(
  geom: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!geom || typeof geom !== 'object') return null;
  const crs = geom.crs as { properties?: { name?: unknown } } | undefined;
  const crsName = String(crs?.properties?.name || '');
  const is4326 = /4326|CRS84/i.test(crsName);
  const coords = geom.coordinates as unknown;
  if (!is4326) {
    const first = firstCoord(coords);
    if (!(first && Math.abs(first[0]) <= 180 && Math.abs(first[1]) <= 90)) {
      return {
        ...geom,
        crs: { type: 'name', properties: { name: 'EPSG:4326' } },
        coordinates: mapCoords(coords, lambert93ToWgs84),
      };
    }
  }
  return { ...geom, crs: { type: 'name', properties: { name: 'EPSG:4326' } } };
}

/* ── URL des tuiles ── */

export const CADASTRE_WMS =
  'https://data.geopf.fr/wms-r/wms';

/** URL des tuiles cadastrales IGN (WMS). */
export function cadastreTileUrl(): string {
  const params = new URLSearchParams({
    service: 'WMS',
    version: '1.3.0',
    request: 'GetMap',
    layers: 'CADASTRALPARCELS.PARCELLAIRE_EXPRESS',
    styles: '',
    format: 'image/png',
    transparent: 'true',
    width: '256',
    height: '256',
    crs: 'EPSG:3857',
  });
  return `${CADASTRE_WMS}?${params.toString()}&bbox={bbox-epsg-3857}`;
}

/** URL des tuiles WMS BRGM pour une couche donnée. */
export function wmsTileUrl(layerName: string): string {
  const params = new URLSearchParams({
    service: 'WMS',
    version: '1.3.0',
    request: 'GetMap',
    layers: layerName,
    format: 'image/png',
    transparent: 'true',
    width: '256',
    height: '256',
    crs: 'EPSG:3857',
  });
  return `${WMS_BASE}?${params.toString()}&bbox={bbox-epsg-3857}`;
}

/* ── WFS ── */
/* Le WFS Géorisques (GeoServer) ne sert que du GML — pas de JSON malgré
 * `outputFormat=application/json` (échoue silencieusement). On demande donc
 * du GML 3.2 et on le convertit nous-mêmes en GeoJSON (parser minimal :
 * gml:Point / gml:LineString / gml:Polygon / gml:MultiSurface, cf. réponse
 * réelle du service — élément wfs:member > <ms:Type> > ms:msGeometry). */

const GML_GEOMETRY_NAMES = new Set([
  'Point', 'LineString', 'Curve',
  'Polygon', 'Surface',
  'MultiPoint', 'MultiLineString', 'MultiCurve', 'MultiPolygon', 'MultiSurface',
]);

/** Vrai si le CRS utilise l'ordre d'axes (lat, lon) — cas des URN OGC pour
 *  EPSG:4326 (`urn:ogc:def:crs:EPSG::4326`), conformément à GML 3.2 / WFS 2.0. */
function isLatLonAxisOrder(srsName: string | null | undefined): boolean {
  if (!srsName) return false;
  return /^urn:/i.test(srsName) && /4326/.test(srsName);
}

function descendantsByLocalName(root: Element, name: string): Element[] {
  const out: Element[] = [];
  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) {
      if (child.localName === name) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

function firstDescendantByLocalName(root: Element, name: string): Element | null {
  return descendantsByLocalName(root, name)[0] ?? null;
}

/** Premier élément géométrie GML rencontré en largeur (évite de prendre un
 *  gml:Polygon imbriqué dans un gml:MultiSurface à la place du MultiSurface). */
function firstGeometryDescendant(root: Element): Element | null {
  const queue: Element[] = Array.from(root.children);
  while (queue.length) {
    const el = queue.shift()!;
    if (GML_GEOMETRY_NAMES.has(el.localName)) return el;
    queue.push(...Array.from(el.children));
  }
  return null;
}

/** Dimension déclarée d'une géométrie GML (`srsDimension`), héritée si absente.
 *
 *  ⚠ Indispensable pour la BD TOPO (IGN) : ses `gml:LineString` sont en
 *  `srsDimension="3"` et `posList` contient alors des TRIPLETS
 *  (lat, lon, altitude). Lire par paires produisait des coordonnées absurdes
 *  (mesuré : un tronçon de 188 909 km). */
export function readSrsDimension(
  el: Element,
  inherited?: number | null
): number {
  const raw = el.getAttribute('srsDimension');
  if (raw) {
    const n = Number(raw);
    if (n === 2 || n === 3) return n;
  }
  if (inherited === 2 || inherited === 3) return inherited;
  let node: Element | null = el.parentElement;
  while (node) {
    const up = node.getAttribute('srsDimension');
    if (up === '2' || up === '3') return Number(up);
    node = node.parentElement;
  }
  return 2;
}

/** Parse une liste de coordonnées GML (`gml:posList`, ou une paire `gml:pos`)
 *  en tenant compte de l'ordre d'axes du CRS ET de la dimension déclarée.
 *
 *  Le troisième élément (altitude) est conservé quand il est présent : la
 *  position GeoJSON reste valide pour Mapbox, et le profil en long du trajet
 *  de l'eau a besoin de l'altitude RÉELLE (jamais interpolée côté client). */
function parseCoordText(
  text: string,
  srsName: string | null,
  dim = 2
): Array<[number, number, number?]> {
  const nums = (text || '').trim().split(/\s+/).map(Number).filter((n) => !Number.isNaN(n));
  const swap = isLatLonAxisOrder(srsName);
  const d = dim === 3 ? 3 : 2;
  const pts: Array<[number, number, number?]> = [];
  for (let i = 0; i + d - 1 < nums.length; i += d) {
    const a = nums[i];
    const b = nums[i + 1];
    if (d === 3) {
      const z = nums[i + 2];
      pts.push(swap ? [b, a, z] : [a, b, z]);
    } else {
      pts.push(swap ? [b, a] : [a, b]);
    }
  }
  return pts;
}

/** Coordonnées d'un anneau (`gml:LinearRing`) ou d'une ligne — supporte
 *  `gml:posList`, la variante legacy `gml:coordinates`, et une suite de
 *  `gml:pos`. L'ordre d'axes ET la dimension sont héritées de la géométrie
 *  porteuse (`gml:LineString` / `gml:Surface`) : ni `posList` ni
 *  `gml:LinearRing` ne les portent eux-mêmes. */
function ringOrLineCoords(
  el: Element,
  inheritedSrs: string | null,
  inheritedDim: number = 2
): Array<[number, number, number?]> | null {
  const srs = el.getAttribute('srsName') || inheritedSrs;
  const dim = readSrsDimension(el, inheritedDim);
  const posList = firstDescendantByLocalName(el, 'posList');
  if (posList) {
    const pts = parseCoordText(
      posList.textContent || '',
      posList.getAttribute('srsName') || srs,
      dim
    );
    return pts.length ? pts : null;
  }
  const coordinates = firstDescendantByLocalName(el, 'coordinates');
  if (coordinates) {
    const pts = (coordinates.textContent || '')
      .trim()
      .split(/\s+/)
      .map((pair) => pair.split(',').map(Number) as [number, number])
      .filter(([x, y]) => !Number.isNaN(x) && !Number.isNaN(y));
    return pts.length ? pts : null;
  }
  const posEls = descendantsByLocalName(el, 'pos');
  if (posEls.length) {
    const pts = posEls
      .map(
        (p) =>
          parseCoordText(p.textContent || '', p.getAttribute('srsName') || srs, dim)[0]
      )
      .filter((p): p is [number, number, number?] => !!p);
    return pts.length ? pts : null;
  }
  return null;
}

type RingPoint = [number, number, number?];

function closeRing(ring: RingPoint[]): RingPoint[] {
  if (ring.length < 2) return ring;
  const [fx, fy] = ring[0];
  const [lx, ly] = ring[ring.length - 1];
  return fx === lx && fy === ly ? ring : [...ring, ring[0]];
}

function polygonRings(
  polygonEl: Element,
  inheritedSrs: string | null,
  inheritedDim: number = 2
): { exterior: RingPoint[]; interiors: RingPoint[][] } | null {
  const srs = polygonEl.getAttribute('srsName') || inheritedSrs;
  const dim = readSrsDimension(polygonEl, inheritedDim);
  const exteriorWrap = firstDescendantByLocalName(polygonEl, 'exterior');
  const ext = exteriorWrap
    ? firstDescendantByLocalName(exteriorWrap, 'LinearRing')
    : firstDescendantByLocalName(polygonEl, 'LinearRing');
  if (!ext) return null;
  const exterior = ringOrLineCoords(ext, srs, dim);
  if (!exterior || exterior.length < 3) return null;
  const interiors: RingPoint[][] = [];
  for (const interiorWrap of descendantsByLocalName(polygonEl, 'interior')) {
    const ring = firstDescendantByLocalName(interiorWrap, 'LinearRing');
    const coords = ring ? ringOrLineCoords(ring, srs, dim) : null;
    if (coords && coords.length >= 3) interiors.push(closeRing(coords));
  }
  return { exterior: closeRing(exterior), interiors };
}

/** Convertit un élément géométrie GML (Point/LineString/Polygon/Multi*) en
 *  géométrie GeoJSON. Couvre les cas rencontrés dans les couches Géorisques
 *  (2-3 attributs utiles suffisent, on ne cherche pas l'exhaustivité GML). */
function gmlGeometryToGeoJson(geomEl: Element, inheritedSrs: string | null): GeoJSON.Geometry | null {
  const srs = geomEl.getAttribute('srsName') || inheritedSrs;
  // La dimension est portée par CET élément (gml:LineString srsDimension="3"),
  // et doit être transmise aux anneaux imbriqués qui ne la portent pas.
  const dim = readSrsDimension(geomEl, null);
  switch (geomEl.localName) {
    case 'Point': {
      const pos = firstDescendantByLocalName(geomEl, 'pos');
      const pt = pos
        ? parseCoordText(pos.textContent || '', pos.getAttribute('srsName') || srs, dim)[0]
        : null;
      return pt ? ({ type: 'Point', coordinates: pt } as unknown as GeoJSON.Geometry) : null;
    }
    case 'LineString':
    case 'Curve': {
      const coords = ringOrLineCoords(geomEl, srs, dim);
      return coords && coords.length >= 2
        ? ({ type: 'LineString', coordinates: coords } as unknown as GeoJSON.Geometry)
        : null;
    }
    case 'Polygon':
    case 'Surface': {
      const rings = polygonRings(geomEl, srs, dim);
      return rings
        ? ({ type: 'Polygon', coordinates: [rings.exterior, ...rings.interiors] } as unknown as GeoJSON.Geometry)
        : null;
    }
    case 'MultiSurface':
    case 'MultiPolygon': {
      const coordinates: number[][][][] = [];
      for (const p of descendantsByLocalName(geomEl, 'Polygon')) {
        const rings = polygonRings(p, srs, dim);
        if (rings) coordinates.push([rings.exterior, ...rings.interiors] as unknown as number[][][]);
      }
      return coordinates.length ? { type: 'MultiPolygon', coordinates } : null;
    }
    case 'MultiCurve':
    case 'MultiLineString': {
      const coordinates: number[][][] = [];
      for (const l of descendantsByLocalName(geomEl, 'LineString')) {
        const coords = ringOrLineCoords(l, srs, dim);
        if (coords && coords.length >= 2) coordinates.push(coords as unknown as number[][]);
      }
      return coordinates.length ? { type: 'MultiLineString', coordinates } : null;
    }
    case 'MultiPoint': {
      const coordinates: number[][] = [];
      for (const p of descendantsByLocalName(geomEl, 'Point')) {
        const pos = firstDescendantByLocalName(p, 'pos');
        const pt = pos
          ? parseCoordText(pos.textContent || '', pos.getAttribute('srsName') || srs, dim)[0]
          : null;
        if (pt) coordinates.push(pt as unknown as number[]);
      }
      return coordinates.length ? { type: 'MultiPoint', coordinates } : null;
    }
    default:
      return null;
  }
}

function elementContains(ancestor: Element, target: Element): boolean {
  let node: Element | null = target;
  while (node) {
    if (node === ancestor) return true;
    node = node.parentElement;
  }
  return false;
}

/** Convertit une réponse WFS GetFeature (GML 3.2) en FeatureCollection
 *  GeoJSON. Ne garde que la géométrie + les propriétés scalaires du feature
 *  (pas de types complexes imbriqués) — suffisant pour le rendu carte. */
export function gmlToGeoJson(xmlText: string): GeoJSON.FeatureCollection | null {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  } catch {
    return null;
  }
  if (doc.getElementsByTagName('parsererror').length) return null;
  const root = doc.documentElement;
  if (!root) return null;

  const members = [
    ...descendantsByLocalName(root, 'member'),
    ...descendantsByLocalName(root, 'featureMember'),
  ];
  const features: GeoJSON.Feature[] = [];
  for (const member of members) {
    const featureEl = member.children[0];
    if (!featureEl) continue;
    const geomEl = firstGeometryDescendant(featureEl);
    const geometry = geomEl ? gmlGeometryToGeoJson(geomEl, null) : null;
    if (!geometry) continue;
    const properties: Record<string, string> = {};
    for (const child of Array.from(featureEl.children)) {
      if (child.localName === 'boundedBy') continue;
      if (geomEl && elementContains(child, geomEl)) continue;
      const text = (child.textContent || '').trim();
      if (text) properties[child.localName] = text;
    }
    features.push({ type: 'Feature', geometry, properties });
  }
  return { type: 'FeatureCollection', features };
}

/** Bbox [west, south, east, north] (degrés WGS84) centrée sur un point, avec
 *  une marge fixe — utilisée pour restreindre les requêtes WFS au voisinage
 *  de l'adresse diagnostiquée. Marge 0.05° (≈ 5,5 km) : les couches vecteur
 *  Géorisques (périmètres PPR, canalisations) couvrent souvent plus large que
 *  le voisinage immédiat de l'adresse — une marge de 0.012° ne ramenait
 *  aucune feature pour ces couches (vérifié en direct sur le service), et la
 *  couche retombait sur le raster WMS ou rien. */
export function bboxAround(lon: number, lat: number, marginDeg = 0.05): [number, number, number, number] {
  return [lon - marginDeg, lat - marginDeg, lon + marginDeg, lat + marginDeg];
}

/** Récupère une couche WFS Géorisques en GeoJSON (GML→GeoJSON, cf. ci-dessus).
 *
 *  Filtre spatial (`BBOX`) plutôt qu'attributaire : vérifié en direct sur le
 *  service, `cql_filter=code_insee='...'` est silencieusement ignoré (les
 *  résultats ne varient pas avec le filtre — bug latent qui faisait
 *  remonter des features d'une commune quelconque). De plus, le nom du champ
 *  commune varie selon la couche (`code_insee` pour SSP, `num_com` pour les
 *  canalisations, absent pour les périmètres PPR) : `BBOX` est le seul filtre
 *  qui fonctionne uniformément quelle que soit la couche interrogée. */
export async function fetchWfsLayer(
  typeName: string,
  bbox: [number, number, number, number]
): Promise<GeoJSON.FeatureCollection | null> {
  const [west, south, east, north] = bbox;
  const url = new URL(WFS_BASE);
  url.searchParams.set('SERVICE', 'WFS');
  url.searchParams.set('VERSION', '2.0.0');
  url.searchParams.set('REQUEST', 'GetFeature');
  url.searchParams.set('TYPENAMES', typeName);
  url.searchParams.set('outputFormat', 'text/xml; subtype=gml/3.2.1');
  url.searchParams.set('count', '200');
  // Ordre d'axes (lat, lon) — URN EPSG:4326 en GML 3.2 / WFS 2.0 (cf. isLatLonAxisOrder).
  url.searchParams.set('BBOX', `${south},${west},${north},${east},urn:ogc:def:crs:EPSG::4326`);
  try {
    const resp = await fetch(url.toString());
    if (!resp.ok) return null;
    const text = await resp.text();
    return gmlToGeoJson(text);
  } catch {
    return null;
  }
}

/* ── Géométrie ── */

/** Centre approximatif d'un Polygon/MultiPolygon GeoJSON (en WGS84). */
export function polygonCenter(
  coords: unknown
): [number, number] | null {
  const ring = firstRing(coords);
  if (!ring || ring.length < 3) return null;
  let lon = 0;
  let lat = 0;
  for (const p of ring) {
    lon += p[0];
    lat += p[1];
  }
  return [lon / ring.length, lat / ring.length];
}

/** Premier anneau externe d'un Polygon/MultiPolygon. */
export function firstRing(
  node: unknown
): Array<[number, number]> | null {
  if (!Array.isArray(node)) return null;
  if (node.length >= 3 && Array.isArray(node[0]) && typeof node[0][0] === 'number') {
    return node as Array<[number, number]>;
  }
  for (const sub of node) {
    const r = firstRing(sub);
    if (r) return r;
  }
  return null;
}