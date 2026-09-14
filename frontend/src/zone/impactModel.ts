// =============================================================================
//   TYPHOON — /zone : ENVELOPPE D'INONDATION (ce que la carte a le droit de
//   dessiner, et jusqu'où).
//
//   Le produit a une règle : aucune surface d'eau n'est inventée. Deux repères
//   différents ne se soustraient pas (une cote d'échelle hydrométrique et une
//   altitude de terrain ne sont pas dans le même référentiel), donc « niveau −
//   terrain » n'existe pas ici. Ce module ne le refait pas.
//
//   Ce qu'il fait : traduire la profondeur que le MOTEUR produit déjà
//   (`effectiveDepthM`, cf. damageModel) en une bande affichable et en une
//   hauteur de volume d'eau dessinable à l'échelle du bâti réel. La profondeur
//   est celle du pied du bâtiment analysé — la même hypothèse que les compteurs
//   de dommages — et elle est reportée sur l'emprise BDNB du secteur.
//
//   Trois conséquences assumées et affichées :
//     · la profondeur est UNIFORME sur le secteur (pas de variation de
//       terrain) : c'est une enveloppe, pas une emprise inondée ;
//     · le seuil de 0,3 m est celui du moteur (`submergedFrac`) — en dessous,
//       il ne compte aucun dommage d'infrastructure : la carte ne doit pas
//       peindre d'eau là où le modèle n'en compte pas ;
//     · la hauteur dessinée est plafonnée par la hauteur RÉELLE du bâti (BDNB) :
//       au-delà, c'est une ruine, pas un immeuble noyé jusqu'au toit.
// =============================================================================

import { effectiveDepthM, type ScenarioDef } from './damageModel';

/** Seuil d'infrastructure du moteur (cf. `submergedFrac` dans damageModel). */
export const INFRA_THRESHOLD_M = 0.3;

/** Pas du volume d'eau dessiné : les propriétés de la carte changent par
 *  paliers de 5 cm, sinon chaque pixel de curseur déclencherait un setData. */
export const SLAB_STEP_M = 0.05;

export interface FloodBand {
  key: string;
  fromM: number;
  /** Borne haute (exclue) ; null = bande ouverte. */
  toM: number | null;
  label: string;
  /** Couleur du volume d'eau sur la carte (dégradé cyan → violet). */
  color: string;
}

/* Bandes d'affichage. Le seuil du moteur (0,3 m) est une borne, pas un
   ornement : la première bande est « rien n'est compté ». */
export const FLOOD_BANDS: FloodBand[] = [
  { key: 'b0', fromM: 0, toM: 0.3, label: '0 – 0,3 m', color: '#8fd8f2' },
  { key: 'b1', fromM: 0.3, toM: 0.5, label: '0,3 – 0,5 m', color: '#4fb4e8' },
  { key: 'b2', fromM: 0.5, toM: 1, label: '0,5 – 1,0 m', color: '#2f7fd6' },
  { key: 'b3', fromM: 1, toM: 1.5, label: '1,0 – 1,5 m', color: '#4b57d6' },
  { key: 'b4', fromM: 1.5, toM: null, label: '> 1,5 m', color: '#7a3fd6' },
];

export function floodBand(depthM: number): FloodBand {
  const d = Number.isFinite(depthM) ? Math.max(0, depthM) : 0;
  let found = FLOOD_BANDS[0];
  for (const b of FLOOD_BANDS) {
    if (d >= b.fromM) found = b;
  }
  return found;
}

export interface ImpactState {
  /** Profondeur modélisée au pied du bâti analysé (m). */
  depthM: number;
  /** Volume d'eau dessinable, arrondi au pas de 5 cm (m). */
  slabM: number;
  band: FloodBand;
  /** La profondeur dépasse-t-elle le seuil d'infrastructure du moteur ? */
  overThreshold: boolean;
  /** Part du pic du scénario atteinte (0..100) — pour la jauge du panneau. */
  peakPct: number;
}

/** Décrit un état d'inondation à partir d'une profondeur déjà calculée. */
export function impactState(depthM: number, peakM: number): ImpactState {
  const d = Number.isFinite(depthM) ? Math.max(0, depthM) : 0;
  const peak = Number.isFinite(peakM) && peakM > 0 ? peakM : 0;
  return {
    depthM: d,
    slabM: quantiseSlab(d),
    band: floodBand(d),
    overThreshold: d > INFRA_THRESHOLD_M,
    peakPct: peak > 0 ? Math.min(100, (d / peak) * 100) : 0,
  };
}

/** État d'inondation du scénario à un avancement donné (0..1). */
export function impactAt(scenario: ScenarioDef, accum: number): ImpactState {
  return impactState(effectiveDepthM(scenario, accum), scenario.depthPeakM);
}

/**
 * Arrondi au pas du volume dessiné. Le passage par les centièmes évite les
 * résidus flottants (14 × 0,05 vaut 0,7000000000000001) : ces valeurs partent
 * telles quelles dans les propriétés GeoJSON lues par la carte.
 */
export function quantiseSlab(depthM: number): number {
  if (!Number.isFinite(depthM)) return 0;
  const steps = Math.round(Math.max(0, depthM) / SLAB_STEP_M);
  return Math.round(steps * SLAB_STEP_M * 100) / 100;
}

/**
 * Le volume dessiné ne dépasse jamais le bâti : au-delà de sa hauteur, il n'y
 * a plus d'immeuble à noyer. Hauteur inconnue → on ne plafonne pas (la carte
 * applique le même `min` côté expression).
 */
export function cappedSlabM(slabM: number, buildingHeightM: number | null | undefined): number {
  if (typeof buildingHeightM !== 'number' || !Number.isFinite(buildingHeightM) || buildingHeightM <= 0) {
    return slabM;
  }
  return Math.min(slabM, buildingHeightM);
}

/** Libellé court de la profondeur, en mètres (une décimale). */
export function fmtDepth(depthM: number): string {
  return `${depthM.toFixed(1)} m`;
}
