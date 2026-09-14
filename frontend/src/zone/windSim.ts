// =============================================================================
//   TYPHOON — /zone : SIMULATION VENT PILOTÉE PAR DONNÉES RÉELLES
//
//   Même architecture que floodSim.ts, appliquée au vent :
//     · le PROFIL est la prévision horaire RÉELLE Open-Meteo (rafales 10 m,
//       km/h) — déjà chargée via /api/meteo, zéro profil synthétique ;
//     · il n'existe PAS de repère réglementaire « classe de vent » équivalent
//       au TRI en métropole : la simulation EST la prévision elle-même. Le
//       seul élément modélisé est le SEUIL d'effets (échelle Beaufort/
//       Carpenter — dégâts possibles dès ~90 km/h de rafale), affiché comme
//       un seuil documenté, jamais comme une mesure.
//
//   Règle d'honnêteté : sans prévision horaire réelle → PAS de simulation.
//   Une prévision calme (pic < seuil d'effets) s'affiche comme telle.
// =============================================================================

import type { MeteoData } from './hydroRoute';

/* ── Profil de rafales RÉEL (Open-Meteo) ── */

export interface GustProfile {
  /** Heures affichables ("00h", …) — index aligné sur `gust`. */
  hours: string[];
  /** Rafale horaire réelle (km/h) ; null → 0. */
  gust: number[];
  /** Vent moyen horaire réel (km/h) ; même axe. */
  speed: number[];
  /** Pic de rafales réel de la prévision (km/h). */
  peakKmh: number;
  /** Index de l'heure de pic. */
  peakIndex: number;
}

/** Seuil d'effets aux personnes/bâtiments (rafales, km/h) — d'après l'échelle
 *  Beaufort / critères Carpenter : dégâts légers possibles dès ~90 km/h,
 *  dégâts importants ~120 km/h, très graves ≥ 150 km/h. Seuil DOCUMENTÉ du
 *  modèle, pas une mesure — l'UI le porte dans son libellé. */
export const GUST_DAMAGE_KMH = 90;
export const GUST_SEVERE_KMH = 120;

/** Construit le profil depuis la prévision RÉELLE. Retourne null si absente
 *  ou vide → pas de simulation (aucun vent inventé). */
export function gustProfileFrom(meteo: MeteoData | null): GustProfile | null {
  const series = (meteo?.wind_gusts_hourly ?? []).filter((p) => p.t);
  if (series.length === 0) return null;

  const speeds = meteo?.wind_speed_hourly ?? [];
  const hours: string[] = [];
  const gust: number[] = [];
  const speed: number[] = [];
  for (const p of series.slice(0, 24)) {
    const d = new Date(p.t);
    hours.push(
      Number.isNaN(d.getTime())
        ? p.t.slice(11, 13) + 'h'
        : `${String(d.getHours()).padStart(2, '0')}h`
    );
    gust.push(typeof p.v === 'number' && p.v >= 0 ? p.v : 0);
    const sp = speeds[series.indexOf(p)];
    speed.push(typeof sp?.v === 'number' && sp.v >= 0 ? sp.v : 0);
  }

  const peak = Math.max(...gust);
  const peakIndex = gust.indexOf(peak);
  if (peak <= 0) return null; // prévision sans vent exploitable

  return { hours, gust, speed, peakKmh: peak, peakIndex };
}

/** Rafale (km/h) à l'index horaire donné (borné). */
export function gustAt(profile: GustProfile | null, hourIndex: number): number {
  if (!profile || profile.gust.length === 0) return 0;
  const i = Math.max(0, Math.min(profile.gust.length - 1, Math.floor(hourIndex)));
  return profile.gust[i];
}

/** Bande d'effets d'une rafale (km/h) — libellés + couleur, seuils documentés. */
export function gustBand(kmh: number): {
  key: 'none' | 'moderate' | 'high' | 'severe';
  label: string;
  color: string;
} {
  if (kmh >= GUST_SEVERE_KMH)
    return { key: 'severe', label: 'Rafales destructrices', color: '#ff3b30' };
  if (kmh >= GUST_DAMAGE_KMH)
    return { key: 'high', label: 'Dégâts possibles', color: '#ff9f0a' };
  if (kmh >= 60)
    return { key: 'moderate', label: 'Vent sensible', color: '#ffd60a' };
  return { key: 'none', label: 'Vent faible', color: '#4da3ff' };
}
