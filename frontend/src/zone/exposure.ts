// =============================================================================
//   TYPHOON — /zone : STATUT D'EXPOSITION D'UN ALÉA (source unique)
//
//   Le rapport affichait, sur la même fiche, « à mon adresse » ET
//   « Résolution : estimation communale ». Les deux ne peuvent pas être vrais :
//   un zonage sismique national ou un comptage ICPE communal ne sont pas des
//   faits au bâtiment.
//
//   Règle (constitution §2 — « Résolution sur chaque fact ») : le LIBELLÉ
//   d'exposition est DÉRIVÉ de la RÉSOLUTION. Une donnée communale ne peut
//   jamais s'afficher comme « à l'adresse ». Le discriminant fiable est la
//   résolution, pas `present` : `present` dit seulement que l'aléa concerne le
//   bien ou sa commune, pas à quelle échelle il a été mesuré.
//
//   Ce module est la seule source de ces libellés — panneau, rapport et
//   synthèse l'utilisent, pour qu'ils ne puissent plus diverger.
// =============================================================================

import type { AleaDetail } from './config';

export type ExposureLevel = 'adresse' | 'commune' | 'absent' | 'inconnu';

export interface Exposure {
  level: ExposureLevel;
  /** Libellé court d'exposition — jamais « à mon adresse » pour du communal. */
  label: string;
  /** Échelle réelle de la donnée, affichée à côté (transparence). */
  resolutionLabel: string;
  /** La donnée est-elle exploitable (ni absente, ni en échec) ? */
  identified: boolean;
}

/** Résolution per-building ? (tolère les deux écritures du contrat). */
function isPerBuilding(alea: AleaDetail): boolean {
  return alea.resolution === 'per-building';
}

function resolutionLabelOf(alea: AleaDetail): string {
  if (isPerBuilding(alea)) return 'testé au bâtiment (polygone)';
  if (alea.resolution === 'commune-level') return 'zonage communal (réglementaire)';
  if (alea.resolution === 'commune-level-estimate') return 'estimation communale';
  return 'échelle non précisée par la source';
}

/**
 * Statut d'exposition d'un aléa, dérivé de la résolution.
 *
 * - `per-building` + concerné → « à l'adresse » (mesuré au bâtiment) ;
 * - échelle communale + concerné → « à l'échelle communale » (jamais « adresse ») ;
 * - source en échec (`erreur`) → « statut inconnu », jamais « absent » :
 *   une panne n'est pas une absence de risque.
 */
export function exposureOf(alea: AleaDetail): Exposure {
  const resolutionLabel = resolutionLabelOf(alea);
  const concerned = alea.present === true || alea.present_commune === true;

  /* Panne de source : on ne sait pas — et on le dit. */
  if (alea.erreur && alea.present == null && alea.present_commune == null) {
    return { level: 'inconnu', label: 'statut inconnu (source indisponible)', resolutionLabel, identified: false };
  }

  if (!concerned) {
    return { level: 'absent', label: 'non recensé', resolutionLabel, identified: false };
  }

  if (isPerBuilding(alea) && alea.present === true) {
    return { level: 'adresse', label: 'à l’adresse', resolutionLabel, identified: true };
  }

  /* Concerné mais mesuré à l'échelle communale (zones sismiques, radon,
     comptages ICPE, zonages PPR…) : c'est le libellé honnête. */
  return { level: 'commune', label: 'à l’échelle communale', resolutionLabel, identified: true };
}

/** Classe CSS de la pastille d'exposition. */
export function exposureClass(level: ExposureLevel): string {
  return `st-${level}`;
}
