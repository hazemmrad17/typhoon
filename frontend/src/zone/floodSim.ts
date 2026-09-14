// =============================================================================
//   TYPHOON — /zone : SIMULATION DE CRUE PILOTÉE PAR DONNÉES RÉELLES
//
//   Remplace l'ancien profil de pluie SYNTHÉTIQUE (HOURLY_RAIN codé en dur) :
//   la montée des eaux est désormais pilotée par la PRÉVISION HORAIRE RÉELLE
//   Open-Meteo du point diagnostiqué (déjà chargée via /api/meteo), et la
//   profondeur culmine à la CLASSE OFFICIELLE TRI (Directive Inondation).
//
//   Règles d'honnêteté (révisées — cf. « le scénario pilote le niveau ») :
//     · sans CLASSE TRI au point → PAS de profondeur (le pic n'est pas
//       deviné) : l'eau reste à 0 — et le panneau le dit ;
//     · la CLASSE OFFICIELLE fixe le NIVEAU (fait réglementaire) ;
//     · la prévision de pluie ne fixe que la FORME de la montée quand elle
//       existe (hypothèse de transport, affichée) ;
//     · journée sèche / météo absente → le niveau reste celui du scénario
//       (jamais 0 : un scénario choisi doit se voir), avec une rampe
//       DOCUMENTÉE et LIBELLÉE comme hypothèse. Une simulation pilotée par la
//       météo seule s'éteignait les jours sans pluie : le scénario sélectionné
//       — qui est un fait réglementaire — devenait invisible, ce qui se lit
//       comme une panne.
//
//   Ce qui reste strictement interdit, et testé : inventer un pic (aucune
//   classe → 0 m) ou peindre de l'eau sans qu'aucun scénario soit choisi.
// =============================================================================

import type { MeteoData } from './hydroRoute';

/* ── Profil de pluie RÉEL (Open-Meteo) ── */

export interface RainProfile {
  /** Heures affichables ("00h", "01h", …) — index aligné sur `rain`. */
  hours: string[];
  /** Pluie horaire réelle (mm/h) ; null → 0 (heure sans valeur). */
  rain: number[];
  /** Cumul réel de la prévision (mm). */
  totalMm: number;
  /** Pic horaire réel (mm/h). */
  peakMmH: number;
  /** Index de l'heure de pic. */
  peakIndex: number;
}

/** Construit le profil de la simulation depuis la prévision RÉELLE.
 *  Retourne null si la prévision est absente ou vide → pas de simulation. */
export function rainProfileFrom(meteo: MeteoData | null): RainProfile | null {
  if (!meteo || meteo.dry) return null;
  const series = (meteo.rain_hourly ?? []).filter((p) => p.t);
  if (series.length === 0) return null;

  const hours: string[] = [];
  const rain: number[] = [];
  for (const p of series.slice(0, 24)) {
    const d = new Date(p.t);
    hours.push(
      Number.isNaN(d.getTime())
        ? p.t.slice(11, 13) + 'h'
        : `${String(d.getHours()).padStart(2, '0')}h`
    );
    rain.push(typeof p.v === 'number' && p.v >= 0 ? p.v : 0);
  }

  const total = meteo.rain_total_mm ?? rain.reduce((a, b) => a + b, 0);
  const peak = Math.max(...rain);
  const peakIndex = rain.indexOf(peak);
  if (total <= 0 || peak <= 0) return null; // prévision sèche → rien à simuler

  return { hours, rain, totalMm: total, peakMmH: peak, peakIndex };
}

/** Cumul normalisé (0..1) de pluie tombée à l'index horaire donné.
 *  C'est le « moteur » de montée : l'eau suit la pluie réellement prévue. */
export function accumFracAt(profile: RainProfile, hourIndex: number): number {
  if (!profile || profile.rain.length === 0) return 0;
  const i = Math.max(0, Math.min(profile.rain.length - 1, Math.floor(hourIndex)));
  let acc = 0;
  for (let h = 0; h <= i; h += 1) acc += profile.rain[h];
  return profile.totalMm > 0 ? Math.min(1, Math.max(0, acc / profile.totalMm)) : 0;
}

/* ── Profondeur : pic OFFICIEL TRI × courbe de montée ── */

/** Part du pic atteinte à un avancement donné (0..1) — hypothèse de transport
 *  affichée comme telle : l'eau démarre à 5 % du pic et le rejoint au cumul
 *  final de pluie. */
export function depthFractionAt(accum: number): number {
  return 0.05 + 0.95 * Math.max(0, Math.min(1, accum));
}

/* ── Forme de montée de repli (journée sèche / météo absente) ──

   Quand aucune prévision ne pilote la crue, le NIVEAU reste celui de la classe
   officielle — c'est un fait — mais sa MONTÉE doit bien prendre une forme.
   Cette rampe est une HYPOTHÈSE DOCUMENTÉE, pas une mesure : montée continue
   de 5 % du pic à minuit jusqu'au pic à 24 h. Elle n'est utilisée QUE s'il n'y
   a pas de profil de pluie, et l'UI dit lequel des deux régimes est actif
   (`curveIsHypothesis`). */

export const SCENARIO_RAMP_START_FRAC = 0.05;

export function scenarioRampAt(hourIndex: number): number {
  const h = Number.isFinite(hourIndex) ? Math.max(0, Math.min(24, hourIndex)) : 0;
  return SCENARIO_RAMP_START_FRAC + (1 - SCENARIO_RAMP_START_FRAC) * (h / 24);
}

/** Profondeur (m) du SCÉNARIO à l'index horaire.

    · la CLASSE fixe le pic — `peakM` null/≤0 → 0 : hors TRI, aucune profondeur
      n'est inventée (règle inchangée, testée) ;
    · la pluie prévue, si elle existe, donne la forme réelle ;
    · sinon la rampe documentée prend le relais et `peakM` s'affiche
      quand même — un scénario réglementaire ne peut pas disparaître parce
      qu'il ne pleut pas aujourd'hui. */
export function scenarioDepthAt(
  profile: RainProfile | null,
  hourIndex: number,
  peakM: number | null | undefined
): number {
  if (typeof peakM !== 'number' || !Number.isFinite(peakM) || peakM <= 0) return 0;
  const frac = profile
    ? depthFractionAt(accumFracAt(profile, hourIndex))
    : scenarioRampAt(hourIndex);
  return peakM * frac;
}

/** La courbe affichée est-elle une HYPOTHÈSE (aucune prévision ne la pilote) ?
 *  Sert au libellé de provenance de la console et du panneau. */
export function curveIsHypothesis(profile: RainProfile | null): boolean {
  return !profile;
}
