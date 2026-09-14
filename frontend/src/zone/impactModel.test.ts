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
import {
  FLOOD_BANDS,
  INFRA_THRESHOLD_M,
  MAP_MIN_DEPTH_M,
  cappedSlabM,
  floodBand,
  fmtDepth,
  impactState,
  mapImpactFromDepth,
  quantiseSlab,
} from './impactModel';

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

describe('impactState — la simulation pilote la profondeur', () => {
  it('au départ, sous le seuil : rien à peindre', () => {
    const start = impactState(0.05, 1.1);
    expect(start.overThreshold).toBe(false);
    expect(start.band.key).toBe('b0');
    expect(start.slabM).toBe(0.05);
  });

  it('au pic TRI (1,1 m), la bande correspond à la classe officielle', () => {
    const peak = impactState(1.1, 1.1);
    expect(peak.band.label).toBe('1,0 – 1,5 m');
    expect(peak.overThreshold).toBe(true);
  });

  it('hors TRI (profondeur 0) : rien n’est peint', () => {
    const none = impactState(0, 0);
    expect(none.overThreshold).toBe(false);
    expect(none.slabM).toBe(0);
    expect(none.peakPct).toBe(0);
  });
});

describe('fmtDepth', () => {
  it('une décimale, en mètres', () => {
    expect(fmtDepth(0.72)).toBe('0.7 m');
    expect(fmtDepth(1)).toBe('1.0 m');
  });
});

// SCN-002 — le seuil de la CARTE n'est pas celui des DOMMAGES : la carte peint
// dès que la profondeur dépasse zéro, sinon la montée de l'eau reste invisible
// pendant tout le début du scrub.
describe('SCN-002 — mapImpactFromDepth : la carte voit l\u2019eau avant le seuil de dommages', () => {
  it('peint d\u00e8s 0,1 m alors que le seuil de dommages (0,3 m) n\u2019est pas franchi', () => {
    const m = mapImpactFromDepth(0.1, 1.1);
    expect(m).not.toBeNull();
    expect(m!.visible).toBe(true);
    expect(m!.slabM).toBe(0.1);
    expect(m!.overThreshold).toBe(false);
    expect(m!.color).toBe(FLOOD_BANDS[0].color);
  });

  it('franchit le seuil de dommages à 0,4 m (bande 0,3 \u2013 0,5 m)', () => {
    const m = mapImpactFromDepth(0.4, 1.1);
    expect(m!.overThreshold).toBe(true);
    expect(m!.band.label).toBe('0,3 \u2013 0,5 m');
  });

  it('ne peint rien \u00e0 z\u00e9ro, sous le seuil visuel, ou si le pas de 5 cm annule la hauteur', () => {
    expect(mapImpactFromDepth(0, 1.1)).toBeNull();
    expect(mapImpactFromDepth(MAP_MIN_DEPTH_M / 2, 1.1)).toBeNull();
    expect(mapImpactFromDepth(Number.NaN, 1.1)).toBeNull();
  });

  it('ne modifie pas le comportement des compteurs de dommages', () => {
    expect(impactState(0.1, 1.1).overThreshold).toBe(false);
    expect(impactState(0.4, 1.1).overThreshold).toBe(true);
    expect(impactState(0.1, 1.1).slabM).toBe(0.1);
  });
});
