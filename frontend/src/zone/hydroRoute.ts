// =============================================================================
//   TYPHOON — /zone : « trajet de l'eau » (client + modèle du parcours).
//
//   Consomme le contrat RÉEL du backend (app/api/routes/hydro.py) :
//     · GET /api/hydro         — réseau IGN BD TOPO : accrochage, amont, aval,
//                                bassin versant, profil en long, propagation ;
//     · GET /api/hydro/extend  — poursuite d'un parcours borné (curseur) ;
//     · GET /api/meteo         — référence réelle (Open-Meteo / GloFAS).
//
//   Trois natures de faits, jamais confondues (c'est la règle du produit) :
//     · GÉOGRAPHIE RÉELLE   — le tracé du cours d'eau, son nom, son bassin,
//                             ses altitudes (BD TOPO) ;
//     · RÉFÉRENCE RÉELLE    — pluie prévue et débit estimé (Open-Meteo) ;
//     · ENVELOPPE MODÉLISÉE — les dommages du scénario (damageModel.ts).
//
//   Aucune de ces fonctions ne jette : un service indisponible renvoie un
//   résultat typé « indisponible » avec sa raison, et l'UI dégrade proprement.
// =============================================================================

import { API } from './config';

/* ── Contrat backend (app/schemas/hydro.py) ── */

export interface HydroStop {
  reason: string;
  label: string;
  node?: string | null;
}

export interface HydroProfilePoint {
  km: number;
  z_m: number;
}

export type HydroDirection = 'up' | 'down';

export interface HydroStretch {
  direction: HydroDirection;
  length_km: number;
  segments: number;
  geometry: { type: 'LineString'; coordinates: Array<[number, number]> } | null;
  profile: HydroProfilePoint[];
  has_more: boolean;
  cursor?: string | null;
  requests?: number;
  stop: HydroStop;
  start_point?: [number, number] | null;
  end_point?: [number, number] | null;
}

export interface HydroBasin {
  libelle?: string | null;
  toponyme?: string | null;
  code?: string | null;
  area_km2?: number | null;
  group_libelle?: string | null;
  geometry: { type: 'Polygon'; coordinates: Array<Array<[number, number]>> } | null;
}

export interface HydroArrival {
  min_hours: number;
  max_hours: number;
  celerity_min_m_s: number;
  celerity_max_m_s: number;
  note: string;
}

export interface HydroRoute {
  lat: number;
  lon: number;
  watercourse?: string | null;
  watercourse_importance?: string | null;
  snap_distance_m?: number | null;
  segments_nearby: number;
  basin?: HydroBasin | null;
  upstream?: HydroStretch | null;
  downstream?: HydroStretch | null;
  arrival?: HydroArrival | null;
  sources: Record<string, string>;
  retrieved_at?: string | null;
  unavailable_reason?: string | null;
  unavailable_label?: string | null;
}

export interface MeteoPoint {
  t: string;
  v: number | null;
}

export interface MeteoData {
  lat: number;
  lon: number;
  rain_hourly: MeteoPoint[];
  rain_total_mm?: number | null;
  rain_peak_mm_h?: number | null;
  dry?: boolean | null;
  /* Vent / rafales horaires RÉELS (km/h) — même axe que la pluie. */
  wind_gusts_hourly?: MeteoPoint[];
  wind_speed_hourly?: MeteoPoint[];
  wind_gust_peak_kmh?: number | null;
  wind_gust_peak_time?: string | null;
  wind_gust_peak_dir_deg?: number | null;
  soil_moisture_hourly?: MeteoPoint[];
  soil_moisture_min?: number | null;
  soil_moisture_max?: number | null;
  discharge?: {
    unit: string;
    series: MeteoPoint[];
    mean: Array<number | null>;
    max: Array<number | null>;
    current?: number | null;
    peak?: number | null;
    peak_date?: string | null;
    elevation_m?: number | null;
  } | null;
  sources: Record<string, string>;
  retrieved_at?: string | null;
  unavailable_reason?: string | null;
  unavailable_label?: string | null;
}

/* ── Appels réseau ── */

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T | null> {
  try {
    const resp = await fetch(url, { signal });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

/** Géographie réelle du trajet de l'eau pour un point. */
export async function fetchHydroRoute(
  lat: number,
  lon: number,
  budget?: number,
  signal?: AbortSignal
): Promise<HydroRoute | null> {
  const q = new URLSearchParams({
    lat: lat.toFixed(6),
    lon: lon.toFixed(6),
    ...(budget ? { budget: String(budget) } : {}),
  });
  return getJson<HydroRoute>(`${API}/api/hydro?${q.toString()}`, signal);
}

/** Référence réelle météo / hydrologie (Open-Meteo, GloFAS). */
export async function fetchMeteo(
  lat: number,
  lon: number,
  signal?: AbortSignal
): Promise<MeteoData | null> {
  const q = new URLSearchParams({ lat: lat.toFixed(6), lon: lon.toFixed(6) });
  return getJson<MeteoData>(`${API}/api/meteo?${q.toString()}`, signal);
}

/* ── Géométrie ── */

export type LonLatZ = [number, number, number?];

export function stretchCoords(stretch?: HydroStretch | null): LonLatZ[] {
  const c = stretch?.geometry?.coordinates;
  return Array.isArray(c) ? (c as LonLatZ[]) : [];
}

/** Une extrémité à l'autre : la longueur du tracé (km). */
export function polylineLengthKm(coords: LonLatZ[]): number {
  let d = 0;
  for (let i = 1; i < coords.length; i += 1) {
    d += haversineM(coords[i - 1], coords[i]);
  }
  return d / 1000;
}

export function haversineM(a: LonLatZ, b: LonLatZ): number {
  const R = 6371000;
  const p1 = (a[1] * Math.PI) / 180;
  const p2 = (b[1] * Math.PI) / 180;
  const dp = ((b[1] - a[1]) * Math.PI) / 180;
  const dl = ((b[0] - a[0]) * Math.PI) / 180;
  const h =
    Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Distances cumulées (km) de chaque sommet d'un tracé. */
export function cumulativeKm(coords: LonLatZ[]): number[] {
  const out: number[] = [0];
  for (let i = 1; i < coords.length; i += 1) {
    out.push(out[i - 1] + haversineM(coords[i - 1], coords[i]) / 1000);
  }
  return out;
}

/** Cap (degrés, 0 = nord) du tracé au sommet i. */
export function bearingAt(coords: LonLatZ[], i: number): number {
  const a = coords[Math.max(0, Math.min(i, coords.length - 2))];
  const b = coords[Math.max(1, Math.min(i + 1, coords.length - 1))];
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

export interface SampledPoint {
  lon: number;
  lat: number;
  z: number | null;
  bearing: number;
  index: number;
}

/** Position interpolée à une distance donnée le long du tracé. */
export function sampleAt(
  coords: LonLatZ[],
  cum: number[],
  km: number,
  fallbackZ: number | null
): SampledPoint | null {
  if (coords.length < 2) return null;
  const total = cum[cum.length - 1];
  const target = Math.max(0, Math.min(total, km));
  let i = 1;
  while (i < cum.length && cum[i] < target) i += 1;
  const iPrev = Math.max(0, i - 1);
  const seg = cum[i] - cum[iPrev];
  const t = seg > 0 ? (target - cum[iPrev]) / seg : 0;
  const a = coords[iPrev];
  const b = coords[Math.min(i, coords.length - 1)];
  const zA = a[2];
  const zB = b[2];
  const z = zA != null && zB != null ? zA + (zB - zA) * t : (zA ?? zB ?? fallbackZ);
  return {
    lon: a[0] + (b[0] - a[0]) * t,
    lat: a[1] + (b[1] - a[1]) * t,
    z: z ?? null,
    bearing: bearingAt(coords, iPrev),
    index: iPrev,
  };
}

/* ── Le « voyage » complet : amont (inversé) → site → aval ──
   L'amont est parcouru de l'origine vers l'adresse, l'aval de l'adresse vers
   l'exutoire : un seul tracé continu, dont on sait où se trouve le site. */

export interface Journey {
  coords: LonLatZ[];
  cum: number[];
  /** Distance cumulée (km) à laquelle se trouve l'adresse diagnostiquée. */
  siteKm: number;
  upstreamKm: number;
  downstreamKm: number;
  totalKm: number;
  /** Profil en long réel, en distance cumulée depuis l'origine. */
  profile: HydroProfilePoint[];
  /** Vrai si au moins une extrémité peut encore être prolongée. */
  extendUp: string | null;
  extendDown: string | null;
}

export function buildJourney(route: HydroRoute): Journey | null {
  const up = stretchCoords(route.upstream);
  const down = stretchCoords(route.downstream);
  if (up.length < 2 && down.length < 2) return null;

  // L'amont est stocké DU SITE VERS L'AMONT → on l'inverse pour partir de
  // l'origine et arriver au site.
  const upReversed = up.length >= 2 ? [...up].reverse() : [];
  const coords: LonLatZ[] = [...upReversed];
  let siteKm = 0;
  if (upReversed.length >= 1) {
    siteKm = polylineLengthKm(upReversed);
  }
  if (down.length >= 2) {
    // On évite le doublon du point de jonction (dernier point amont = 1er aval).
    const skip = coords.length ? 1 : 0;
    coords.push(...down.slice(skip));
  }

  const cum = cumulativeKm(coords);
  const upstreamKm = polylineLengthKm(upReversed);
  const downstreamKm = polylineLengthKm(down);

  // Profil en long : on reconstruit les distances dans le repère du voyage.
  const profile: HydroProfilePoint[] = [];
  const shift = upstreamKm;
  for (const p of route.upstream?.profile ?? []) {
    // profil amont stocké depuis le site → distance = shift - p.km
    profile.push({ km: Math.max(0, shift - p.km), z_m: p.z_m });
  }
  for (const p of route.downstream?.profile ?? []) {
    profile.push({ km: shift + p.km, z_m: p.z_m });
  }
  profile.sort((a, b) => a.km - b.km);

  return {
    coords,
    cum,
    siteKm,
    upstreamKm,
    downstreamKm,
    totalKm: cum[cum.length - 1] ?? 0,
    profile,
    extendUp: route.upstream?.has_more ? route.upstream.cursor ?? null : null,
    extendDown: route.downstream?.has_more ? route.downstream.cursor ?? null : null,
  };
}

/** Concatène une portion prolongée à la portion d'origine (mêmes extrémités). */
export function mergeStretch(base: HydroStretch, more: HydroStretch): HydroStretch {
  const a = stretchCoords(base);
  const b = stretchCoords(more);
  const coords: LonLatZ[] = [...a, ...b.slice(a.length ? 1 : 0)];
  const last = a[a.length - 1];
  const first = b[0];
  const contiguous = last && first ? haversineM(last, first) < 60 : true;
  return {
    ...base,
    length_km: base.length_km + more.length_km,
    segments: base.segments + more.segments,
    geometry: { type: 'LineString', coordinates: coords as Array<[number, number]> },
    profile: [...base.profile, ...more.profile.map((p) => ({ km: p.km + base.length_km, z_m: p.z_m }))],
    has_more: more.has_more,
    cursor: more.cursor,
    // Une discontinuité (trou de réseau) est signalée, jamais masquée.
    stop: contiguous
      ? more.stop
      : { reason: 'gap', label: 'discontinuité de réseau entre deux portions', node: null },
    end_point: more.end_point ?? base.end_point,
  };
}

/* ── Mise en forme ── */

export function fmtKm(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

export function fmtHours(h: number): string {
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 24) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} j`;
}
