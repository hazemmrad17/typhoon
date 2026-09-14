// =============================================================================
//   TYPHOON — /zone : MOTEUR D'ESTIMATION DES DOMMAGES (phase « étape 2 »)
//
//   Remplace les valeurs factices des panneaux par des estimations calculées :
//       Dommage = f(intensité de l'aléa × exposition du secteur × courbe de
//     vulnérabilité)   — même architecture que la méthodologie HAZUS / FEMA.
//
//   Le panneau des scénarios (droite) et la console temporelle (bas) fournissent
//   l'« entrée météo » ; le rapport de diagnostic fournit l'exposition BDNB. Le
//   panneau gauche consomme la SORTIE commune : en changeant de scénario ou en
//   défilant la timeline, chaque widget est recalculé.
//
//   ⚠ Honnêteté épistémique : ces chiffres sont MODÉLISÉS (courbes empiriques),
//   pas mesurés — chaque valeur porte donc une fourchette d'incertitude (±).
//   Les compteurs d'exposition (arbres, véhicules, routes…) sont des proxies
//   dérivés de l'emprise BDNB tant qu'un référentiel statique réel n'est pas
//   ingéré. Ne jamais présenter une sortie comme une donnée terrain.
// =============================================================================

import type { RisqueReport } from './config';

/* ── Entrée météo à un instant t de l'événement ── */
export interface MeteoInput {
  /** Vent soutenu (km/h) à l'instant t. */
  windKmh: number;
  /** Intensité de pluie (mm/h) à l'instant t. */
  rainMmH: number;
  /** Hauteur d'eau (m) au pied du bâtiment à l'instant t. */
  depthM: number;
}

/* ── Exposition statique du secteur (référentiel à ingérer ; proxies BDNB) ── */
export interface BuildingExposure {
  /** Nombre de bâtiments à l'adresse. */
  count: number;
  /** Emprise totale (m²). */
  totalAreaM2: number;
  /** Logements totaux. */
  totalUnits: number;
  /** Valeur de remplacement totale (€). */
  totalValueEUR: number;
  /** Étages moyens. */
  avgFloors: number;
  /** Hauteur moyenne (m). */
  avgHeightM: number;
}

export interface StaticExposure {
  buildings: BuildingExposure;
  /** Nombre d'arbres dans le secteur (proxy). */
  trees: number;
  /** Véhicules en stationnement estimés (proxy). */
  parkedVehicles: number;
  /** Longueur de voirie (km) (proxy). */
  roadKm: number;
  /** Longueur de lignes électriques (km) (proxy). */
  powerLineKm: number;
  /** Longueur de conduites (km) (proxy). */
  conduitKm: number;
}

/* ── Plage de valeurs : estimation + fourchette d'incertitude ── */
export interface Range {
  v: number;
  low: number;
  high: number;
}

export interface DamageEstimate {
  brokenTrees: Range;
  damagedVehicles: Range;
  downedPowerLines: Range;
  floodedConduitM: Range;
  damagedBuildings: Range;
  damagedRoadsM: Range;
  waterLevelFt: Range;
  damageEUR: Range;
  damageUSD: Range;
  /** Habitations touchées (index de gravité « HP » du panneau scénario). */
  hp: Range;
}

/* ── Définition d'un scénario : bande d'intensité + probabilité ── */
export interface ScenarioDef {
  key: string;
  pct: number;
  risk: string;
  windPeakKmh: number;
  rainPeakMmH: number;
  depthPeakM: number;
  most?: boolean;
}

/* ── Les 4 scénarios probables (mêmes clés/probabilités que le panneau) ──
   Chaque scénario est une BANDE d'intensité (vent / pluie / hauteur d'eau). */
export const SCENARIOS: ScenarioDef[] = [
  {
    key: 'direct',
    pct: 81,
    risk: 'HIGH DAMAGE RISK',
    windPeakKmh: 125,
    rainPeakMmH: 26,
    depthPeakM: 1.1,
    most: true,
  },
  {
    key: 'west',
    pct: 62,
    risk: 'MODERATE DAMAGE RISK',
    windPeakKmh: 95,
    rainPeakMmH: 18,
    depthPeakM: 0.7,
  },
  {
    key: 'east',
    pct: 44,
    risk: 'MODERATE DAMAGE RISK',
    windPeakKmh: 75,
    rainPeakMmH: 13,
    depthPeakM: 0.45,
  },
  {
    key: 'offshore',
    pct: 22,
    risk: 'LOW DAMAGE RISK',
    windPeakKmh: 55,
    rainPeakMmH: 8,
    depthPeakM: 0.2,
  },
];

export function scenarioFor(key: string): ScenarioDef {
  return SCENARIOS.find((s) => s.key === key) ?? SCENARIOS[0];
}

/* ── Profil temporel de l'événement — même axe que la console basse (mm/h).
   « norm » = intensité relative de l'heure (0..1) ; « accum » = part du cumul
   déjà tombé (0..1, la hauteur d'eau s'accumule dans l'événement). ── */
export const HOURLY_RAIN = [2, 1, 1, 0, 0, 0, 1, 2, 4, 6, 9, 12, 15, 24, 25, 20, 16, 12, 8, 5, 3, 2, 1, 1];
export const MAX_RAIN = Math.max(...HOURLY_RAIN);
const TOTAL_RAIN = HOURLY_RAIN.reduce((a, b) => a + b, 0);

export function timeProfileAt(hourIndex: number): { rain: number; norm: number; accum: number } {
  const i = Math.max(0, Math.min(23, Math.floor(hourIndex)));
  const rain = HOURLY_RAIN[i];
  const norm = MAX_RAIN > 0 ? rain / MAX_RAIN : 0;
  let acc = 0;
  for (let h = 0; h <= i; h += 1) acc += HOURLY_RAIN[h];
  const accum = TOTAL_RAIN > 0 ? acc / TOTAL_RAIN : 0;
  return { rain, norm, accum };
}

/* ── Niveau d'eau du moteur — ENVELOPPE DE SCÉNARIO, jamais une observation.
   La profondeur suit le profil d'accumulation du scénario à l'instant t :
   lire la timeline fait donc monter l'eau du modèle.

   ⚠ Ce nombre n'est PAS une cote mesurée : c'est l'hypothèse d'intensité de
   la bande de scénario. Le repère RÉEL opposable (débit de rivière estimé
   GloFAS, pluie prévue Open-Meteo) est affiché À CÔTÉ, jamais fusionné avec
   cette enveloppe (cf. zone/hydroRoute.ts + RiskConsole). ── */
export const M_TO_FT = 3.28084;

/** Part du pic du scénario atteinte à un avancement donné (0..1). */
export function depthFractionAt(accum: number): number {
  return 0.05 + 0.95 * Math.max(0, Math.min(1, accum));
}

/** Hauteur d'eau de l'enveloppe de scénario (m) à un instant de l'événement. */
export function effectiveDepthM(scenario: ScenarioDef, accum: number): number {
  return scenario.depthPeakM * depthFractionAt(accum);
}

/* ── Courbes de vulnérabilité (logistiques empiriques, style HAZUS) ── */
const logistic = (v: number, x0: number, k: number): number => 1 / (1 + Math.exp(-(v - x0) / k));

/** P(arbre cassé | vent) — 50 % vers ~95 km/h. */
export function pTreeBreak(windKmh: number): number {
  return logistic(windKmh, 95, 14);
}

/** Taux de défaillance de ligne électrique par km (base + logistique). */
export function pPowerLineFailPerKm(windKmh: number): number {
  return 0.03 + 0.4 * logistic(windKmh, 115, 12);
}

/** P(véhicule endommagé | vent + eau). */
export function pVehicleDamage(windKmh: number, depthM: number): number {
  const fromWind = 0.5 * logistic(windKmh, 120, 12);
  const fromFlood = 0.7 * logistic(depthM, 0.35, 0.15);
  return Math.min(1, fromWind + fromFlood);
}

/** Fraction de dommage structurel (% ) par hauteur d'eau (USACE/HAZUS). */
export function depthDamageFrac(depthM: number): number {
  return Math.min(1, 0.08 + 0.62 * (1 - Math.exp(-depthM / 0.7)));
}

/** Fraction de linéaire submergé au-delà du seuil d'infrastructure (0,3 m). */
function submergedFrac(depthM: number): number {
  if (depthM <= 0.3) return 0;
  return Math.min(1, (depthM - 0.3) / 0.6);
}

/* ── Fourchette d'incertitude relative (les sorties sont modélisées) ── */
function rng(v: number, spread = 0.28): Range {
  return {
    v,
    low: Math.max(0, v * (1 - spread)),
    high: v * (1 + spread),
  };
}

/* ── Exposition statique dérivée du rapport BDNB (proxies documentés) ── */
export function exposureFromReport(report: RisqueReport | null): StaticExposure {
  const b = report?.bdnb?.batiment ?? null;
  const others = report?.bdnb?.autres_batiments_meme_adresse ?? [];
  const count = (b ? 1 : 0) + others.length;

  const area = b?.surface_emprise_sol ?? b?.s_geom_groupe ?? 150;
  const totalAreaM2 = area * Math.max(1, count);
  const units = b?.nb_log ?? Math.max(1, Math.round(count * 12));
  const totalUnits = units * Math.max(1, count);
  const floors = b?.nb_niveau ?? 3;
  const height = b?.hauteur_mean ?? floors * 3;
  // Valeur de remplacement : ~1 800 €/m² (habitation moyenne France).
  const totalValueEUR = totalAreaM2 * 1800;

  // Proxies d'exposition échelle sur l'emprise / les logements réels.
  const trees = Math.max(1, Math.round(totalAreaM2 / 250));
  const parkedVehicles = Math.max(1, Math.round(totalUnits * 0.7));
  const roadKm = Math.max(0.1, count * 0.25);
  const powerLineKm = Math.max(0.1, count * 0.2);
  const conduitKm = Math.max(0.2, count * 0.35);

  return {
    buildings: {
      count: Math.max(1, count),
      totalAreaM2,
      totalUnits,
      totalValueEUR,
      avgFloors: floors,
      avgHeightM: height,
    },
    trees,
    parkedVehicles,
    roadKm,
    powerLineKm,
    conduitKm,
  };
}

/* ── Moteur : calcule l'estimation pour un scénario × un instant ── */
export function computeDamage(
  exposure: StaticExposure,
  scenario: ScenarioDef,
  time: { norm: number; accum: number }
): DamageEstimate {
  // Intensité à l'instant t : le vent/la pluie suivent le pic du scénario,
  // modulé par la position dans l'événement ; l'eau s'accumule.
  const wind = 5 + scenario.windPeakKmh * (0.15 + 0.85 * time.norm);
  const depth = effectiveDepthM(scenario, time.accum);

  const { buildings } = exposure;
  const unitsPerBuilding = buildings.count > 0 ? buildings.totalUnits / buildings.count : 1;

  const brokenTrees = exposure.trees * pTreeBreak(wind);
  const damagedVehicles = exposure.parkedVehicles * pVehicleDamage(wind, depth);
  const downedPowerLines = exposure.powerLineKm * pPowerLineFailPerKm(wind);
  const floodedConduitM = exposure.conduitKm * 1000 * submergedFrac(depth);
  const damagedRoadsM = exposure.roadKm * 1000 * submergedFrac(depth);

  const frac = depthDamageFrac(depth);
  const damagedBuildings = buildings.count * Math.min(1, frac * 1.2);
  const hp = damagedBuildings * unitsPerBuilding;

  // Coûts de remise en état (€) : structure + réseaux.
  const structuralEUR = buildings.totalValueEUR * frac;
  const infraEUR =
    brokenTrees * 350 +
    damagedVehicles * 12000 +
    downedPowerLines * 8000 +
    floodedConduitM * 300 +
    damagedRoadsM * 250;
  const damageEUR = structuralEUR + infraEUR;

  return {
    brokenTrees: rng(brokenTrees),
    damagedVehicles: rng(damagedVehicles),
    downedPowerLines: rng(downedPowerLines),
    floodedConduitM: rng(floodedConduitM, 0.3),
    damagedBuildings: rng(damagedBuildings, 0.3),
    damagedRoadsM: rng(damagedRoadsM, 0.3),
    waterLevelFt: rng(depth * M_TO_FT, 0.2),
    damageEUR: rng(damageEUR, 0.32),
    damageUSD: rng(damageEUR * 1.08, 0.32),
    hp: rng(hp, 0.3),
  };
}

/* ── Formatage ── */
export function fmtInt(r: Range): string {
  return `${Math.round(r.v).toLocaleString('fr-FR')}`;
}
export function fmtRange(r: Range): string {
  const spread = Math.max(1, Math.round(r.high - r.v)).toLocaleString('fr-FR');
  return `${Math.round(r.v).toLocaleString('fr-FR')} ±${spread}`;
}
export function fmtMoneyEUR(r: Range): string {
  if (r.v >= 1_000_000) return `${(r.v / 1_000_000).toFixed(1)} M€`;
  if (r.v >= 1000) return `${Math.round(r.v / 1000)} k€`;
  return `${Math.round(r.v)} €`;
}