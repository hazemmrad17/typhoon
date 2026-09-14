// =============================================================================
//   SCN-010 — la boucle scénario → carte, sans DOM ni réseau.
//
//   Le symptôme rapporté : « la carte reste souvent sèche ». La cause était la
//   résolution scénario → classe TRI (SCN-001) : chaque clé UI (`extreme`,
//   `moyen`, …) tombait sur `undefined`, donc sur `null`, donc sur aucune eau
//   peinte — quel que soit le scénario choisi, la pluie et le scrub de timeline.
//
//   Ce test verrouille la chaîne complète telle que `Zone.tsx` la compose :
//
//     clé scénario → classe TRI officielle → pic (m) → profil de pluie RÉEL
//                  → profondeur à l'instant t → eau dessinée sur la carte
//
//   Aucun maillon n'invente une valeur : sans classe TRI ou sans prévision, la
//   chaîne s'arrête et la carte reste sèche — c'est voulu, et testé.
// =============================================================================

import { describe, expect, it } from 'vitest';
import { SCENARIOS } from './damageModel';
import {
  bandPeakM,
  mostIntenseMappedScenario,
  triDepthForScenario,
  type FloodAleaResult,
  type TriScenario,
} from './floodAlea';
import { rainProfileFrom, scenarioDepthAt } from './floodSim';
import { mapImpactFromDepth } from './impactModel';
import type { MeteoData } from './hydroRoute';

/* Fixture : adresse cartographiée TRI avec une pluie prévue réaliste. */
function triFixture(): FloodAleaResult {
  const scen = (
    key: TriScenario['key'],
    min: number,
    max: number | null,
    label: string,
    present = true
  ): TriScenario => ({
    key,
    label,
    present,
    depth_band: present ? { min_m: min, max_m: max, label } : null,
    cours_deau: present ? 'La Seine' : null,
    id_tri: present ? 'TRI-PARIS' : null,
  });
  return {
    available: true,
    reason: null,
    in_tri: true,
    resolution: 'per-building',
    scenarios: [
      scen('frequent', 0, 0.5, '0 – 0,5 m'),
      scen('moyen', 0.5, 1, '0,5 – 1 m'),
      scen('extreme', 1, 2, '1 – 2 m'),
      scen('faiable', 0, 0.5, '0 – 0,5 m', false),
    ],
    source: 'Géorisques WFS',
    source_url: null,
    retrieved_at: '2026-09-14T00:00:00+00:00',
  };
}

const METEO: MeteoData = {
  lat: 48.86,
  lon: 2.34,
  rain_hourly: Array.from({ length: 24 }, (_, h) => ({
    t: `2026-09-14T${String(h).padStart(2, '0')}:00:00`,
    v: h >= 12 && h <= 16 ? 12 : 0,
  })),
  rain_total_mm: 60,
  dry: false,
  sources: { rain: 'Open-Meteo' },
} as MeteoData;

/* La composition exacte de `Zone.tsx` (extraits, pas de React). */
function mapWaterFor(scenarioKey: string, timeMin: number, tri: FloodAleaResult | null, meteo: MeteoData | null) {
  const scen = triDepthForScenario(tri, scenarioKey);
  const triPeak = scen && scen.depth_band ? bandPeakM(scen.depth_band) : null;
  const profile = rainProfileFrom(meteo);
  const depth = scenarioDepthAt(profile, timeMin / 60, triPeak);
  return mapImpactFromDepth(depth, triPeak ?? 0);
}

describe('SCN-010 — boucle scénario → enveloppe d’eau sur la carte', () => {
  it('CHAQUE clé de scénario du moteur produit une eau dessinée à mi-journée', () => {
    const tri = triFixture();
    for (const s of SCENARIOS) {
      if (s.key === 'faible') continue; /* non cartographié dans la fixture */
      const impact = mapWaterFor(s.key, 840, tri, METEO);
      expect(impact, `scénario ${s.key} sans eau`).not.toBeNull();
      expect(impact!.slabM).toBeGreaterThan(0);
      expect(impact!.visible).toBe(true);
    }
  });

  it('le rang le plus intense peint plus haut que le rang fréquent', () => {
    const tri = triFixture();
    const extreme = mapWaterFor('extreme', 840, tri, METEO)!;
    const frequent = mapWaterFor('frequent', 840, tri, METEO)!;
    expect(extreme.slabM).toBeGreaterThan(frequent.slabM);
  });

  it('le scrub de la timeline fait MONTER l’eau (pas de rechargement réseau)', () => {
    const tri = triFixture();
    const dawn = mapWaterFor('extreme', 60, tri, METEO);
    const noon = mapWaterFor('extreme', 840, tri, METEO)!;
    /* À 01:00 la pluie n'a pas commencé : rien d'obligatoire à peindre.
       À midi l'eau est là, et strictement plus haute si elle existait déjà. */
    if (dawn) expect(noon.slabM).toBeGreaterThan(dawn.slabM);
    expect(noon.slabM).toBeGreaterThan(0);
  });

  it('l’eau apparaît AVANT le seuil de dommages (SCN-002)', () => {
    const tri = triFixture();
    /* 12:00, la pluie vient de commencer : le pic « fréquent » (0,25 m) n'a pas
       encore été rejoint — la profondeur reste SOUS 0,3 m et la carte peint
       pourtant déjà (le seuil de dommages ne gouverne que les compteurs). */
    const impact = mapWaterFor('frequent', 720, tri, METEO)!;
    expect(impact.overThreshold).toBe(false);
    expect(impact.slabM).toBeLessThan(0.3);
    expect(impact.visible).toBe(true);
  });

  it('hors TRI : aucune eau, quelle que soit la pluie', () => {
    const horsTri: FloodAleaResult = { ...triFixture(), available: false, scenarios: [] };
    expect(mapWaterFor('extreme', 840, horsTri, METEO)).toBeNull();
  });

  /* ── Régression : les deux causes du « rien ne se passe » constatées sur une
     adresse réelle (Paris) ── */

  it('JOURNÉE SÈCHE : le scénario reste visiblement simulé (plus de carte morte)', () => {
    const tri = triFixture();
    const dry = { ...METEO, dry: true, rain_hourly: [], rain_total_mm: 0 } as MeteoData;

    /* Avant : aucune eau possible sans pluie prévue — le scénario choisi
       disparaissait les jours secs. */
    const impact = mapWaterFor('extreme', 840, tri, dry);
    expect(impact).not.toBeNull();
    expect(impact!.slabM).toBeGreaterThan(0);

    /* Et la montée va bien jusqu'au pic de la CLASSE (1–2 m → 1,5 m). */
    const atPeak = mapWaterFor('extreme', 1440, tri, dry)!;
    expect(atPeak.slabM).toBeCloseTo(1.5, 2);
  });

  it('hors TRI au point : toujours AUCUNE eau, même avec de la pluie', () => {
    const horsTri: FloodAleaResult = { ...triFixture(), available: false, scenarios: [] };
    expect(mapWaterFor('extreme', 840, horsTri, METEO)).toBeNull();
    expect(mapWaterFor('extreme', 840, horsTri, null)).toBeNull();
  });

  it('aucune classe TRI au point : aucune eau (le pic n’est jamais deviné)', () => {
    const mapped = triFixture();
    const noScenario: FloodAleaResult = {
      ...mapped,
      available: true,
      scenarios: mapped.scenarios.map((s) => ({ ...s, present: false, depth_band: null })),
    };
    expect(mapWaterFor('extreme', 840, noScenario, METEO)).toBeNull();
  });
});

/* ── Cause #2 : le scénario ouvert par défaut n'était pas cartographié ──
   Sur une adresse dont seule la classe « faible » est cartographiée (cas réel
   à Paris), l'écran s'ouvrait sur « extrême » → aucun pic → aucune eau.
   La sélection par défaut doit tomber sur la classe la plus intense qui EXISTE. */
describe('SCN-001b — sélection par défaut : la classe la plus intense cartographiée', () => {
  const order = SCENARIOS.map((s) => s.key);

  it('se rabat sur « faible » quand seule cette classe est cartographiée', () => {
    const mapped = triFixture();
    const onlyFaible: FloodAleaResult = {
      ...mapped,
      scenarios: mapped.scenarios.map((s) =>
        s.key === 'faiable'
          ? { ...s, present: true, depth_band: { min_m: 0, max_m: 1, label: '0 – 1 m' } }
          : { ...s, present: false, depth_band: null }
      ),
    };
    expect(mostIntenseMappedScenario(onlyFaible, order)).toBe('faible');
  });

  it('choisit la plus intense quand plusieurs sont cartographiées', () => {
    expect(mostIntenseMappedScenario(triFixture(), order)).toBe('extreme');
  });

  it('ne renvoie rien quand rien n’est cartographié', () => {
    expect(mostIntenseMappedScenario(null, order)).toBeNull();
    const horsTri: FloodAleaResult = { ...triFixture(), available: false, scenarios: [] };
    expect(mostIntenseMappedScenario(horsTri, order)).toBeNull();
  });
});
