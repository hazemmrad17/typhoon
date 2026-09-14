// =============================================================================
//   TYPHOON — /zone : SIMULATIONS PAR ALÉA (données réelles uniquement)
//
//   Un moteur de visualisation par aléa diagnostiqué, même règle partout :
//     · la simulation n'existe que si le diagnostic a trouvé CE risque à
//       l'adresse (report.aleas[code].present === true) — le panneau filtre ;
//     · les ENTRÉES sont réelles (prévision Open-Meteo, zonage réglementaire,
//       périmètre PPR) ; la FORME est une hypothèse affichée comme telle ;
//     · une donnée manquante → null → rien n'est dessiné.
//
//   Ce sont des SVG/canvas légers, pas une scène 3D : chaque figure reste
//   lisible, sourcée et imprimable — une vue Three.js n'ajouterait rien
//   qu'un décor ne soutient pas.
// =============================================================================

import type { MeteoData, MeteoPoint } from './hydroRoute';

/* ── FEU DE FORÊT : cône d'exposition orienté par le vent RÉEL ── */

export interface FireCone {
  /** Direction de provenance du vent au pic de rafales (° ; 0=N, 90=E). */
  fromDeg: number;
  /** Longueur du cône (unités arbitraires, normalisées 0..1 pour le SVG). */
  reach: number;
  /** Angle d'ouverture (°) — rétrécit quand le vent forcit. */
  spreadDeg: number;
  /** Pic de rafales réel (km/h) — affiché en provenance. */
  gustPeakKmh: number | null;
}

/** Cône d'exposition feu : la longueur suit la rafale réelle (au-delà du seuil
 *  d'effets 90 km/h → portée maximale), l'ouverture se resserre avec le vent
 *  (le feu s'aligne). Vent calme → cône court et large (risque diffus). */
export function fireConeFrom(meteo: MeteoData | null): FireCone | null {
  const gust = meteo?.wind_gust_peak_kmh;
  if (typeof gust !== 'number' || gust <= 0) return null;
  const t = Math.max(0, Math.min(1, (gust - 20) / 130)); // 20 → 150 km/h
  return {
    fromDeg: meteo?.wind_gust_peak_dir_deg ?? 0,
    reach: 0.25 + 0.75 * t,
    spreadDeg: 90 - 55 * t,
    gustPeakKmh: gust,
  };
}

/* ── SCN-021 — le cône de feu devient une GÉOMÉTRIE de carte ──

   Le SVG du panneau est une vignette ; la carte est la source de vérité
   visuelle. Ce producteur traduit le même cône (mêmes entrées réelles :
   rafale de pic et sa direction) en polygône GeoJSON ancré au point
   diagnostiqué.

   Ce qui est MODÈLE, et dit comme tel dans la légende : la portée et
   l'ouverture. Ce qui est RÉEL : l'orientation (direction du vent au pic de
   rafales) et le point d'origine. Aucune météo → aucun polygône.

   Échelle assumée : la portée est proportionnelle à la rafale, bornée à
   `FIRE_REACH_MAX_KM` — ce n'est pas une propagation physique calculée. */

/** Portée maximale dessinée (km) — borne d'affichage, pas une prédiction. */
export const FIRE_REACH_MAX_KM = 1.5;

/** Rayon de la TERRE (m) pour l'approximation sphérique locale. */
const EARTH_R_M = 6371000;

/** Point décalé de `distKm` dans un cap `bearingDeg` (0=N, 90=E). */
function offsetLonLat(
  lon: number,
  lat: number,
  bearingDeg: number,
  distKm: number
): [number, number] {
  const d = (distKm * 1000) / EARTH_R_M;
  const br = (bearingDeg * Math.PI) / 180;
  const lat1 = (lat * Math.PI) / 180;
  const lon1 = (lon * Math.PI) / 180;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(br) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
    );
  return [(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI];
}

export interface FireConeGeometry {
  type: 'Feature';
  properties: {
    /** Provenance du vent au pic réel (°) — la donnée pilotante. */
    fromDeg: number;
    /** Rafale de pic réelle (km/h), ou null si la prévision n'en donne pas. */
    gustPeakKmh: number | null;
    /** Portée dessinée (km) et ouverture (°) — hypothèse de forme. */
    reachKm: number;
    spreadDeg: number;
  };
  geometry: { type: 'Polygon'; coordinates: number[][][] };
}

/** Polygone d'exposition feu orienté par le vent RÉEL, ancré au point.
 *  `null` sans cône (météo absente) ou sans coordonnées exploitables. */
export function fireConePolygon(
  meteo: MeteoData | null,
  origin: { lon: number; lat: number } | null
): FireConeGeometry | null {
  if (!origin || !Number.isFinite(origin.lon) || !Number.isFinite(origin.lat)) return null;
  const cone = fireConeFrom(meteo);
  if (!cone) return null;

  const reachKm = cone.reach * FIRE_REACH_MAX_KM;
  const half = cone.spreadDeg / 2;
  /* Le feu s'éloigne DANS le sens du vent : la direction de provenance est
     retournée de 180° (vent de secteur 310° → propagation vers 130°). */
  const heading = (cone.fromDeg + 180) % 360;

  const apex: [number, number] = [origin.lon, origin.lat];
  const left = offsetLonLat(origin.lon, origin.lat, heading - half, reachKm);
  const right = offsetLonLat(origin.lon, origin.lat, heading + half, reachKm);

  return {
    type: 'Feature',
    properties: {
      fromDeg: cone.fromDeg,
      gustPeakKmh: cone.gustPeakKmh,
      reachKm,
      spreadDeg: cone.spreadDeg,
    },
    geometry: {
      type: 'Polygon',
      coordinates: [[apex, left, right, apex]],
    },
  };
}

/* ── RGA : chronique de dessiccation RÉELLE (humidité du sol) ── */
export interface RgaProfile {
  /** Heures affichables — index aligné sur `moisture`. */
  hours: string[];
  /** Humidité du sol réelle (m³/m³), couche 0–7 cm. */
  moisture: number[];
  /** Minimum de la série (point le plus sec = retrait maximal). */
  min: number;
  /** Maximum de la série. */
  max: number;
  /** Amplitude relative sur la série (0..1) — proxy d'intensité de retrait. */
  swing: number;
}

/** Série RGA depuis l'humidité du sol RÉELLE Open-Meteo. null sans donnée. */
export function rgaProfileFrom(meteo: MeteoData | null): RgaProfile | null {
  const series: MeteoPoint[] = (meteo?.soil_moisture_hourly ?? []).filter(
    (p) => p.t && typeof p.v === 'number'
  );
  if (series.length < 2) return null;

  const hours: string[] = [];
  const moisture: number[] = [];
  for (const p of series.slice(0, 24)) {
    const d = new Date(p.t);
    hours.push(
      Number.isNaN(d.getTime())
        ? p.t.slice(11, 13) + 'h'
        : `${String(d.getHours()).padStart(2, '0')}h`
    );
    moisture.push(p.v as number);
  }
  const min = Math.min(...moisture);
  const max = Math.max(...moisture);
  if (max <= 0) return null;
  return { hours, moisture, min, max, swing: (max - min) / max };
}

/* ── SÉISMICITÉ : zone réglementaire → accélération de référence ── */

export interface SeismicProfile {
  /** Zone sismique nationale (1..5). */
  zone: number;
  /** Accélération de référence agR (m/s²) — décret n°2010-1255, table
   *  officielle : 0,7 / 1,3 / 2,5 / 5 / 10. C'est un FAIT réglementaire. */
  agr: number;
  label: string;
}

const SEISMIC_TABLE: Record<number, { agr: number; label: string }> = {
  1: { agr: 0.7, label: 'Sismicité très faible' },
  2: { agr: 1.3, label: 'Sismicité faible' },
  3: { agr: 2.5, label: 'Sismicité modérée' },
  4: { agr: 5.0, label: 'Sismicité forte' },
  5: { agr: 10.0, label: 'Sismicité très forte' },
};

/** Profil sismique depuis la zone officielle du diagnostic. null hors table. */
export function seismicFrom(zone: number | null | undefined): SeismicProfile | null {
  if (typeof zone !== 'number') return null;
  const row = SEISMIC_TABLE[zone];
  return row ? { zone, ...row } : null;
}
