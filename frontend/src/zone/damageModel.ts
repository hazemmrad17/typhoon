// =============================================================================
//   TYPHOON — /zone : SCÉNARIOS D'INONDATION (calés sur le TRI officiel)
//
//   Les 4 bandes ne portent PLUS aucune intensité synthétique (vent/pluie/eau
//   inventés) : chaque bande correspond à une CLASSE RÉGLEMENTAIRE TRI
//   (Directive Inondation) — extrême ~500 ans, moyen ~100 ans, fréquent
//   ~10 ans, faible. La profondeur vient exclusivement de la classe officielle
//   cartographiée au point (cf. floodAlea.ts) ; le profil temporel vient de la
//   pluie prévue réelle (cf. floodSim.ts).
//
//   Sans TRI au point, une bande n'a PAS de profondeur : l'UI l'affiche
//   « non cartographié » au lieu d'inventer un pic.
// =============================================================================

/* ── Bandes de scénario (clés stables de l'UI) ── */
export interface ScenarioDef {
  key: string;
  risk: string;
  most?: boolean;
}

export const SCENARIOS: ScenarioDef[] = [
  { key: 'extreme', risk: 'EXTREME — ~500 ans', most: true },
  { key: 'moyen', risk: 'REFERENCE — ~100 ans' },
  { key: 'frequent', risk: 'FREQUENT — ~10 ans' },
  { key: 'faible', risk: 'FAIBLE' },
];

export function scenarioFor(key: string): ScenarioDef {
  return SCENARIOS.find((s) => s.key === key) ?? SCENARIOS[0];
}
