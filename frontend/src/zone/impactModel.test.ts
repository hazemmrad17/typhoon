// =============================================================================
//   Tests — /zone : enveloppe d'inondation (bandes, pas de quantification, cap).
//
//   Ce module décide de ce que la carte a le droit de peindre. Trois règles
//   sont verrouillées ici :
//     1. le seuil du moteur (0,3 m) est une frontière : en dessous, il ne
//        compte aucun dommage d'infrastructure — donc la carte ne peint rien ;
//     2. le volume dessiné avance par pas de 5 cm (jamais au pixel de curseur) ;
//     3. il ne dépasse jamais la hauteur réelle du bâti (BDNB).
// =============================================================================

import { describe, expect, it } from 'vitest';
import { SCENARIOS, scenarioFor, effectiveDepthM, timeProfileAt } from './damageModel';
import {
  FLOOD_BANDS,
  INFRA_THRESHOLD_M,
  cappedSlabM,
  floodBand,
  fmtDepth,
  impactAt,
  impactState,
  quantiseSlab,
} from './impactModel';

const DIRECT = scenarioFor('direct'); // profondeur de pic 1,1 m

describe('floodBand — le seuil du moteur est une frontière, pas un ornement', () => {
  it('la bande « rien n’est compté » s’arrête exactement au seuil du moteur', () => {
    expect(FLOOD_BANDS[0].toM).toBe(INFRA_THRESHOLD_M);
    expect(FLOOD_BANDS[1].fromM).toBe(INFRA_THRESHOLD_M);
  });

  it('à 0,29 m on est encore sous le seuil, à 0,30 m on le franchit', () => {
    expect(floodBand(0.29).key).toBe('b0');
    expect(floodBand(INFRA_THRESHOLD_M).key).toBe('b1');
  });

  it('chaque borne haute est la borne basse de la suivante (aucun trou)', () => {
    for (let i = 0; i < FLOOD_BANDS.length - 1; i += 1) {
      expect(FLOOD_BANDS[i].toM).toBe(FLOOD_BANDS[i + 1].fromM);
    }
    expect(FLOOD_BANDS[FLOOD_BANDS.length - 1].toM).toBeNull();
  });

  it('couvre les profondeurs extrêmes sans trou', () => {
    expect(floodBand(0).key).toBe('b0');
    expect(floodBand(0.5).key).toBe('b2');
    expect(floodBand(1).key).toBe('b3');
    expect(floodBand(1.5).key).toBe('b4');
    expect(floodBand(9).key).toBe('b4');
  });

  it('entrées aberrantes : traitée comme 0, jamais comme NaN', () => {
    expect(floodBand(-3).key).toBe('b0');
    expect(floodBand(Number.NaN).key).toBe('b0');
  });
});

describe('quantiseSlab — le volume dessiné avance par pas de 5 cm', () => {
  it('arrondit au pas', () => {
    expect(quantiseSlab(0.72)).toBe(0.7);
    expect(quantiseSlab(0.73)).toBe(0.75);
    expect(quantiseSlab(0.024)).toBe(0);
    expect(quantiseSlab(1.1)).toBe(1.1);
  });

  it('ne descend jamais sous zéro', () => {
    expect(quantiseSlab(-1)).toBe(0);
    expect(quantiseSlab(Number.NaN)).toBe(0);
  });
});

describe('cappedSlabM — on ne noie pas un immeuble au-dessus de son toit', () => {
  it('plafonne à la hauteur réelle du bâti', () => {
    expect(cappedSlabM(3, 2)).toBe(2);
    expect(cappedSlabM(1.1, 22)).toBe(1.1);
  });

  it('hauteur inconnue : on ne plafonne pas (la carte applique le min)', () => {
    expect(cappedSlabM(1.1, null)).toBe(1.1);
    expect(cappedSlabM(1.1, undefined)).toBe(1.1);
    expect(cappedSlabM(1.1, 0)).toBe(1.1);
  });
});

describe('impactState', () => {
  it('le seuil est franchi STRICTEMENT au-delà de 0,3 m', () => {
    expect(impactState(0.3, 1.1).overThreshold).toBe(false);
    expect(impactState(0.31, 1.1).overThreshold).toBe(true);
  });

  it('jauge : part du pic du scénario atteinte', () => {
    expect(impactState(0, 1.1).peakPct).toBe(0);
    expect(impactState(0.55, 1.1).peakPct).toBe(50);
    expect(impactState(1.1, 1.1).peakPct).toBe(100);
    expect(impactState(99, 1.1).peakPct).toBe(100);
  });

  it('pic inconnu ou nul : jauge à 0, jamais une division par zéro', () => {
    expect(impactState(0.5, 0).peakPct).toBe(0);
    expect(impactState(0.5, Number.NaN).peakPct).toBe(0);
  });
});

describe('impactAt — la timeline fait monter l’eau du modèle', () => {
  it('monte de façon monotone avec l’avancement de l’événement', () => {
    const depths = [0, 0.25, 0.5, 0.75, 1].map((a) => impactAt(DIRECT, a).depthM);
    for (let i = 1; i < depths.length; i += 1) {
      expect(depths[i]).toBeGreaterThanOrEqual(depths[i - 1]);
    }
    expect(depths[depths.length - 1]).toBeCloseTo(DIRECT.depthPeakM, 6);
  });

  it('au départ de l’événement, l’enveloppe est sous le seuil (rien à peindre)', () => {
    const start = impactAt(DIRECT, 0);
    expect(start.overThreshold).toBe(false);
    expect(start.band.key).toBe('b0');
    expect(start.slabM).toBe(0.05);
  });

  it('au pic, la bande correspond bien à la profondeur de pic du scénario', () => {
    const peak = impactAt(DIRECT, 1);
    expect(peak.depthM).toBeCloseTo(1.1, 6);
    expect(peak.band.label).toBe('1,0 – 1,5 m');
  });

  it('reste cohérent avec le moteur : même profondeur que effectiveDepthM', () => {
    for (const s of SCENARIOS) {
      for (const h of [0, 6, 13, 23]) {
        const accum = timeProfileAt(h).accum;
        expect(impactAt(s, accum).depthM).toBeCloseTo(effectiveDepthM(s, accum), 9);
      }
    }
  });

  it('le scénario le plus faible ne peint rien de tout l’événement', () => {
    const low = scenarioFor('offshore'); // pic 0,2 m, sous le seuil de 0,3 m
    expect(impactAt(low, 1).overThreshold).toBe(false);
    expect(impactAt(low, 1).band.key).toBe('b0');
  });
});

describe('fmtDepth', () => {
  it('une décimale, en mètres', () => {
    expect(fmtDepth(0.72)).toBe('0.7 m');
    expect(fmtDepth(1)).toBe('1.0 m');
  });
});
