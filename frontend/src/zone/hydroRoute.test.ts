// Le modèle du « trajet de l'eau » doit être vérifiable sans réseau : ce sont
// des fonctions pures (assemblage du voyage, échantillonnage, fusion de
// portions, mise en forme). Les fixtures reprennent la forme réelle du contrat
// backend (/api/hydro).
import { describe, expect, it } from 'vitest';

import {
  buildJourney,
  cumulativeKm,
  fmtHours,
  fmtKm,
  mergeStretch,
  polylineLengthKm,
  sampleAt,
  stretchCoords,
  type HydroRoute,
  type HydroStretch,
  type LonLatZ,
} from './hydroRoute';

/* Deux tronçons de ~1 km vers le nord (0.0045° de latitude ≈ 0,5 km par
   segment) — les longueurs déclarées et les géométries sont cohérentes. */
const DOWN: HydroStretch = {
  direction: 'down',
  length_km: 1.0,
  segments: 2,
  geometry: {
    type: 'LineString',
    coordinates: [
      [2.35, 48.85],
      [2.35, 48.8545],
      [2.35, 48.859],
    ],
  },
  profile: [
    { km: 0, z_m: 30 },
    { km: 0.5, z_m: 29 },
    { km: 1.0, z_m: 28 },
  ],
  has_more: true,
  cursor: 'down|NOEUD-A|28',
  stop: { reason: 'budget', label: 'parcours borné', node: 'NOEUD-A' },
  start_point: [2.35, 48.85],
  end_point: [2.35, 48.859],
};

const UP: HydroStretch = {
  direction: 'up',
  length_km: 1.0,
  segments: 2,
  // Stocké DU SITE vers l'amont : les coordonnées descendent.
  geometry: {
    type: 'LineString',
    coordinates: [
      [2.35, 48.85],
      [2.35, 48.8455],
      [2.35, 48.841],
    ],
  },
  profile: [
    { km: 0, z_m: 30 },
    { km: 0.5, z_m: 31 },
    { km: 1.0, z_m: 32 },
  ],
  has_more: false,
  cursor: null,
  stop: { reason: 'source', label: 'source', node: 'NOEUD-S' },
  start_point: [2.35, 48.85],
  end_point: [2.35, 48.841],
};

const ROUTE: HydroRoute = {
  lat: 48.85,
  lon: 2.35,
  watercourse: 'La Seine',
  snap_distance_m: 91,
  segments_nearby: 12,
  basin: { libelle: 'Seine-Normandie', toponyme: 'La Seine du confluent…', geometry: null },
  upstream: UP,
  downstream: DOWN,
  arrival: {
    min_hours: 4.4,
    max_hours: 10.9,
    celerity_min_m_s: 1,
    celerity_max_m_s: 2.5,
    note: 'cinématique',
  },
  sources: {},
};

describe('buildJourney', () => {
  it('assemble amont inversé → site → aval en un tracé continu', () => {
    const j = buildJourney(ROUTE)!;
    expect(j).not.toBeNull();
    // 3 points amont inversés + 2 points aval (jonction dédupliquée) = 5.
    expect(j.coords).toHaveLength(5);
    // Le tracé part de l'origine amont (le plus au sud)…
    expect(j.coords[0][1]).toBeCloseTo(48.841, 3);
    // …passe par le site…
    expect(j.siteKm).toBeGreaterThan(0.9);
    expect(j.siteKm).toBeLessThan(1.1);
    // …et finit à l'exutoire aval (le plus au nord).
    expect(j.coords[j.coords.length - 1][1]).toBeCloseTo(48.859, 3);
  });

  it('expose les curseurs des extrémités prolongeables', () => {
    const j = buildJourney(ROUTE)!;
    expect(j.extendDown).toBe('down|NOEUD-A|28');
    expect(j.extendUp).toBeNull();
  });

  it('reconstruit le profil en long dans le repère du voyage', () => {
    const j = buildJourney(ROUTE)!;
    const zs = j.profile.map((p) => p.z_m);
    // Le point le plus haut du profil (32 m) est en amont, le plus bas (28 m)
    // en aval — c'est le sens réel de l'écoulement.
    expect(Math.max(...zs)).toBe(32);
    expect(Math.min(...zs)).toBe(28);
    expect(j.profile[0].km).toBeLessThan(j.profile[j.profile.length - 1].km);
    // Le profil couvre bien les deux rives du site.
    expect(j.profile.some((p) => p.km < j.siteKm)).toBe(true);
    expect(j.profile.some((p) => p.km > j.siteKm)).toBe(true);
  });

  it('renvoie null quand aucune portion n’est reconstituable', () => {
    expect(buildJourney({ ...ROUTE, upstream: null, downstream: null })).toBeNull();
  });

  it('tolère une seule direction', () => {
    const j = buildJourney({ ...ROUTE, upstream: null })!;
    expect(j.upstreamKm).toBe(0);
    expect(j.siteKm).toBe(0);
    expect(j.totalKm).toBeGreaterThan(0);
  });
});

describe('géométrie', () => {
  it('mesure la longueur d’un tracé', () => {
    const coords = stretchCoords(DOWN);
    expect(polylineLengthKm(coords)).toBeCloseTo(1.0, 1);
  });

  it('échantillonne par distance le long du tracé', () => {
    const coords = stretchCoords(DOWN);
    const cum = cumulativeKm(coords);
    const mid = sampleAt(coords, cum, 0.5, 0)!;
    expect(mid.lat).toBeCloseTo(48.8545, 2);
    expect(mid.lon).toBeCloseTo(2.35, 4);
    // Le cap suit la marche vers le nord.
    expect(Math.abs(mid.bearing)).toBeLessThan(1);
  });

  it('interpole l’altitude réelle, et ne l’invente jamais quand elle manque', () => {
    const withZ: LonLatZ[] = [
      [2.35, 48.85, 30],
      [2.35, 48.8545, 29],
      [2.35, 48.859, 28],
    ];
    const cum = cumulativeKm(withZ);
    expect(sampleAt(withZ, cum, 0.5, null)!.z).toBeCloseTo(29, 1);
    expect(sampleAt(withZ, cum, 0.25, null)!.z).toBeCloseTo(29.5, 1);
    // Sans altitude BD TOPO (« Pas de Z »), on retombe sur la référence
    // fournie, jamais sur une valeur inventée à partir du voisin.
    const noZ: LonLatZ[] = [
      [2.35, 48.85],
      [2.35, 48.859],
    ];
    expect(sampleAt(noZ, cumulativeKm(noZ), 0.5, 32)!.z).toBe(32);
  });

  it('borne l’échantillonnage aux extrémités', () => {
    const coords = stretchCoords(DOWN);
    const cum = cumulativeKm(coords);
    expect(sampleAt(coords, cum, -5, 0)!.lat).toBeCloseTo(48.85, 3);
    expect(sampleAt(coords, cum, 1e6, 0)!.lat).toBeCloseTo(48.859, 3);
  });
});

describe('mergeStretch', () => {
  it('concatène la suite et n’ajoute pas le point de jonction en double', () => {
    const more: HydroStretch = {
      ...DOWN,
      length_km: 1.0,
      segments: 1,
      geometry: {
        type: 'LineString',
        coordinates: [
          [2.35, 48.859],
          [2.35, 48.8635],
        ],
      },
      has_more: false,
      cursor: null,
      stop: { reason: 'exutoire', label: 'exutoire', node: 'NOEUD-E' },
    };
    const merged = mergeStretch(DOWN, more);
    expect(stretchCoords(merged)).toHaveLength(4);
    expect(merged.has_more).toBe(false);
    expect(merged.cursor).toBeNull();
    expect(merged.stop.reason).toBe('exutoire');
    expect(merged.length_km).toBeCloseTo(2.0, 1);
  });

  it('signale explicitement une discontinuité de réseau au lieu de la masquer', () => {
    const gap: HydroStretch = {
      ...DOWN,
      geometry: {
        type: 'LineString',
        coordinates: [
          [2.35, 49.2], // 37 km plus au nord : trou de réseau
          [2.35, 49.21],
        ],
      },
      stop: { reason: 'budget', label: 'parcours borné', node: 'X' },
    };
    const merged = mergeStretch(DOWN, gap);
    expect(merged.stop.reason).toBe('gap');
    expect(merged.stop.label).toContain('discontinuité');
  });
});

describe('mise en forme', () => {
  it('formate les distances et les durées', () => {
    expect(fmtKm(0.35)).toBe('350 m');
    expect(fmtKm(2.34)).toBe('2.3 km');
    expect(fmtKm(74.4)).toBe('74 km');
    expect(fmtHours(0.5)).toBe('30 min');
    expect(fmtHours(4.4)).toBe('4.4 h');
    expect(fmtHours(30)).toBe('1.3 j');
  });
});
