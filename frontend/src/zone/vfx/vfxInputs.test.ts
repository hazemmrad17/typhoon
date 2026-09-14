// =============================================================================
//   VFX-003 — bus d'entrées du mode VFX (constitution §2.1).
//
//   Règles verrouillées :
//     1. le niveau vient des MÊMES drivers que le mode data (`scenarioDepthAt`
//        sur la pluie réelle × la classe TRI) — **même valeur, même instant** ;
//        VFX et data ne peuvent pas afficher deux hauteurs différentes ;
//     2. le repli illustratif ne porte QUE sur la forme de la courbe, jamais
//        sur la hauteur, et n'est signalé (`partial`) qu'en VFX ;
//     3. sans classe TRI, rien n'est produit : le rendu reste vide plutôt que
//        d'inventer une exposition.
// =============================================================================

import { describe, expect, it } from 'vitest';
import { vfxSourceLabel, vfxWaterLevel } from './vfxInputs';
import { rainProfileFrom, scenarioDepthAt } from '../floodSim';
import type { MeteoData } from '../hydroRoute';

const WET: MeteoData = {
  lat: 48.86,
  lon: 2.34,
  rain_hourly: Array.from({ length: 24 }, (_, h) => ({
    t: `2026-09-14T${String(h).padStart(2, '0')}:00:00`,
    v: h >= 8 && h <= 18 ? 8 : 0,
  })),
  rain_total_mm: 88,
  dry: false,
  sources: { rain: 'Open-Meteo' },
} as MeteoData;

describe('VFX-003 — vfxWaterLevel', () => {
  it('avec prévision réelle : le niveau ÉGALE la valeur du mode data (même driver)', () => {
    const profile = rainProfileFrom(WET)!;
    const lvl = vfxWaterLevel({ rainProfile: profile, hourIndex: 13, triPeak: 1.5, allowFallback: false });

    expect(lvl.source).toBe('forecast');
    expect(lvl.partial).toBe(false);
    expect(lvl.levelM).toBeCloseTo(scenarioDepthAt(profile, 13, 1.5), 10);
  });

  it('sans pluie mais avec classe TRI : MÊME hauteur qu’en mode data, montée signalée illustrative', () => {
    const lvl = vfxWaterLevel({
      rainProfile: null,
      hourIndex: 12,
      triPeak: 2,
      allowFallback: true,
    });

    /* La hauteur est celle du scénario — jamais une constante de décor. */
    expect(lvl.levelM).toBeCloseTo(scenarioDepthAt(null, 12, 2), 10);
    expect(lvl.partial).toBe(true);
    expect(lvl.source).toBe('fallback');
  });

  it('le mode data (allowFallback=false) ne porte jamais le libellé illustratif', () => {
    const lvl = vfxWaterLevel({
      rainProfile: null,
      hourIndex: 12,
      triPeak: 2,
      allowFallback: false,
    });
    expect(lvl.source).toBe('forecast');
    expect(lvl.partial).toBe(false);
    expect(lvl.levelM).toBeGreaterThan(0);
  });

  it('hors TRI : aucun niveau, même en VFX (pas d’exposition inventée)', () => {
    const lvl = vfxWaterLevel({
      rainProfile: null,
      hourIndex: 12,
      triPeak: null,
      allowFallback: true,
    });
    expect(lvl.source).toBe('none');
    expect(lvl.levelM).toBe(0);
  });

  it('provenance : libellés explicites, vocabulaire non contractuel', () => {
    expect(vfxSourceLabel('forecast')).toContain('prévision réelle');
    expect(vfxSourceLabel('fallback')).toContain('rampe documentée');
    expect(vfxSourceLabel('none')).toContain('aucune classe TRI');
  });
});
