// =============================================================================
//   TYPHOON — /zone : ENTRÉES DU MODE VFX (constitution §2.1)
//
//   Le mode VFX est une couche de PRÉSENTATION. Il ne change aucune sémantique
//   d'API et ne doit jamais laisser croire à une précision hydraulique.
//
//   Ce module est la seule porte d'entrée des grandeurs qui alimentent le rendu
//   cinématique. Il applique la règle d'entrée du §2.1 :
//
//     · le niveau d'eau vient des MÊMES drivers que le mode data — `timeMin`
//       (hourIndex), profil de pluie réel Open-Meteo et pic de la classe TRI
//       officielle (`floodAlea`), via `scenarioDepthAt`. VFX et data affichent
//       la MÊME hauteur ; seule la manière de la peindre diffère ;
//     · le drapeau `partial` est porté par la FORME de la courbe : quand aucune
//       pluie n'est prévue, le niveau reste celui du scénario (fait) mais la
//       montée est une rampe documentée. L'UI affiche alors « Données
//       partielles — rendu illustratif » ;
//     · aucune donnée réelle (pas de classe TRI) → `source: 'none'` : le rendu
//       n'affiche rien. On ne remplit pas le vide avec du décor.
//
//   NOTE (simplification) : une constante de « profondeur de repli » (1,0 m)
//   avait été prévue par le plan VFX-003. Elle a été RETIRÉE : dès lors que la
//   classe officielle pilote le niveau, cette constante était à la fois
//   incohérente avec le mode data (deux hauteurs différentes pour le même
//   scénario) et inatteignable. Le repli illustratif porte désormais sur la
//   FORME, jamais sur la hauteur — ce qui est strictement plus honnête.
//
//   Le mode data, lui, n'importe JAMAIS ce module : `impactModel` reste intact
//   et honnête (aucune valeur de repli n'y entre).
// =============================================================================

import { curveIsHypothesis, scenarioDepthAt, type RainProfile } from '../floodSim';

export type VfxWaterLevelSource = 'forecast' | 'fallback' | 'none';

export interface VfxWaterLevel {
  /** Niveau d'eau à afficher (m) — 0 quand rien ne peut être montré. */
  levelM: number;
  /** Le rendu s'appuie-t-il sur une donnée partielle ? → libellé secondaire. */
  partial: boolean;
  /** Provenance de la valeur — affichée dans le disclaimer VFX. */
  source: VfxWaterLevelSource;
}

/**
 * Niveau d'eau du mode VFX à un instant donné.
 *
 * @param rainProfile  profil de pluie RÉEL (Open-Meteo) — null si absent
 * @param hourIndex    heure courante (timeMin / 60)
 * @param triPeak      pic de la classe TRI officielle (m) — null hors TRI
 * @param allowFallback mode VFX : autorise le libellé « rendu illustratif »
 *                      quand la montée n'est pas pilotée par la pluie
 */
export function vfxWaterLevel({
  rainProfile,
  hourIndex,
  triPeak,
  allowFallback,
}: {
  rainProfile: RainProfile | null;
  hourIndex: number;
  triPeak: number | null;
  allowFallback: boolean;
}): VfxWaterLevel {
  const levelM = scenarioDepthAt(rainProfile, hourIndex, triPeak);

  /* Aucune classe TRI : aucun ancrage réglementaire — le rendu reste vide,
     même en VFX. Le décor ne remplace pas une exposition. */
  if (levelM <= 0) return { levelM: 0, partial: true, source: 'none' };

  /* Niveau = fait (classe officielle) ; seule la FORME peut être illustrée. */
  const hypothesis = curveIsHypothesis(rainProfile);
  return {
    levelM,
    partial: hypothesis && allowFallback,
    source: hypothesis && allowFallback ? 'fallback' : 'forecast',
  };
}

/** Libellé humain de la provenance — utilisé par le disclaimer VFX. */
export function vfxSourceLabel(source: VfxWaterLevelSource): string {
  if (source === 'forecast') return 'prévision réelle (Open-Meteo × classe TRI)';
  if (source === 'fallback')
    return 'niveau : classe TRI officielle · montée : rampe documentée (aucune pluie prévue)';
  return 'aucune classe TRI au point — rien à représenter';
}
