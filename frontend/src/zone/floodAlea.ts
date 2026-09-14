// =============================================================================
//   TYPHOON — /zone : REPÈRE RÉGLEMENTAIRE D'INONDATION (Directive Inondation)
//
//   Le moteur de dommages (damageModel) fait tourner des BANDES D'INTENSITÉ
//   synthétiques. Ce module branche à leurs côtés — et dans leurs paramètres —
//   le repère OFFICIEL : la cartographie TRI (Territoires à Risque Important,
//   Directive Inondation 2007/60/CE) sert par le WFS Géorisques, et donne par
//   scénario (fréquent ~10 ans / moyen ~100 ans / extrême ~500 ans / faible)
//   la CLASSE de hauteur d'eau dans laquelle tombe le point analysé.
//
//   C'est l'équivalent français du « depth by probability » de Flood Factor :
//   une profondeur par période de retour, réglementaire et opposable — au lieu
//   d'une profondeur uniquement inventée par le moteur.
//
//   Règles d'honnêteté :
//     · la bande TRI est un FAIT réglementaire (polygone testé au point) ;
//     · la profondeur représentative dérivée d'une bande (milieu de classe,
//       ou min + 0,5 m pour une bande ouverte « ≥ X ») est du MODÈLE et le dit
//       — jamais affichée sans sa classe d'origine ;
//     · hors TRI ≠ jamais inondé : `available=false` porte sa raison ;
//     · service indisponible → `present=null` par scénario, l'UI retombe sur
//       l'enveloppe synthétique pure sans rien inventer.
// =============================================================================

import { API } from './config';

/* ── Contrat backend (app/schemas/flood.py) ── */

export interface TriDepthBand {
  min_m: number;
  /** Borne haute exclue ; null = bande ouverte « ≥ min_m » (sentinelle 9999). */
  max_m: number | null;
  label: string;
}

export interface TriScenario {
  key: 'frequent' | 'moyen' | 'extreme' | 'faiable';
  label: string;
  present: boolean | null;
  depth_band: TriDepthBand | null;
  cours_deau: string | null;
  id_tri: string | null;
}

export interface FloodAleaResult {
  available: boolean;
  reason: string | null;
  /** Le point est-il dans le PÉRIMÈTRE d'un TRI (`ms:LIMITETRI`) ?
   *   `true`  — dans un TRI, mais aucune classe de hauteur à cet endroit ;
   *   `false` — dans aucun TRI ;
   *   `null`  — indéterminé (couche indisponible) : jamais présenté comme un
   *             « hors TRI » acquis.
   *  Mesuré : des quais réellement en TRI (Orléans, Lyon) rendaient « hors
   *  TRI » faute de classe au point — deux absences différentes. */
  in_tri: boolean | null;
  resolution: string;
  scenarios: TriScenario[];
  source: string;
  source_url: string | null;
  retrieved_at: string;
}

/** Résolution TRI au point analysé (ou null si la route est indisponible). */
export async function fetchFloodAlea(
  lat: number,
  lon: number,
  signal?: AbortSignal
): Promise<FloodAleaResult | null> {
  try {
    const q = new URLSearchParams({ lat: lat.toFixed(6), lon: lon.toFixed(6) });
    const resp = await fetch(`${API}/api/flood-alea?${q.toString()}`, { signal });
    if (!resp.ok) return null;
    return (await resp.json()) as FloodAleaResult;
  } catch {
    return null;
  }
}

/* ── SCN-001 — Une seule source de vérité pour les clés de scénario ──

   Les clés UI du moteur (`damageModel.SCENARIOS[].key`) SONT désormais les
   clés réglementaires TRI : `extreme | moyen | frequent | faible`. La
   résolution scénario → classe TRI est donc l'IDENTITÉ : plus d'indirection
   (l'ancienne table `direct/west/east/offshore` faisait résoudre toutes les
   sélections UI vers `undefined`, donc vers `null` — la carte restait sèche).

   Les anciennes clés restent acceptées comme ALIAS DÉPRÉCIÉS (liens partagés,
   état navigateur d'une version antérieure) et ne servent plus de chemin
   nominal. `README` de ce module : ordre décroissant identique des deux côtés
   (extrême → faible). */
export const SCENARIO_TRI_KEY: Record<string, TriScenario['key']> = {
  /* identité — chemin nominal (SCN-001) */
  extreme: 'extreme',
  moyen: 'moyen',
  frequent: 'frequent',
  faible: 'faiable',
  /* déprécié — anciennes clés de bandes UI */
  direct: 'extreme',
  west: 'moyen',
  east: 'frequent',
  offshore: 'faiable',
};

/** @deprecated Alias historique de `SCENARIO_TRI_KEY` (SCN-001). Conservé le
 *  temps de migrer les appelants ; ne pas utiliser dans du code neuf. */
export const UI_SCENARIO_TRI_KEY = SCENARIO_TRI_KEY;

/** Le scénario réglementaire TRI visé par une clé UI (ou null si la clé est
 *  inconnue). Exporté : les panneaux peuvent distinguer « clé inconnue » de
 *  « classe non cartographiée ». */
export function triScenarioKeyFor(uiScenarioKey: string): TriScenario['key'] | null {
  return SCENARIO_TRI_KEY[uiScenarioKey] ?? null;
}

/** Classe TRI à utiliser pour un scénario UI donné (null = rien de
 *  cartographié ou service indisponible pour ce scénario). */
export function triDepthForScenario(
  tri: FloodAleaResult | null,
  uiScenarioKey: string
): TriScenario | null {
  if (!tri || !tri.available) return null;
  const regKey = triScenarioKeyFor(uiScenarioKey);
  if (!regKey) return null;
  const scen = tri.scenarios.find((s) => s.key === regKey) ?? null;
  if (!scen || scen.present !== true || !scen.depth_band) return null;
  return scen;
}

/** Le scénario le plus INTENSE réellement cartographié au point, dans l'ordre
 *  d'intensité décroissante fourni (`SCENARIOS`). `null` si aucun ne l'est.

 *  Sert à la sélection par défaut : sans cela, une adresse dont seule la classe
 *  « faible » est cartographiée ouvrait l'écran sur « extrême » — aucun pic,
 *  aucune eau, bouton de lecture inerte : une panne apparente là où il y a
 *  simplement une autre classe disponible. */
export function mostIntenseMappedScenario(
  tri: FloodAleaResult | null,
  orderByIntensity: readonly string[]
): string | null {
  for (const key of orderByIntensity) {
    if (triDepthForScenario(tri, key)) return key;
  }
  return null;
}

/** Profondeur représentative (m) d'une classe officielle — ENTRÉE DU MOTEUR.
 *  Classe fermée [min, max[ → milieu de classe ; bande ouverte « ≥ min » →
 *  min + 0,5 m (choix de modélisation affiché avec la fourchette ± du moteur). */
export function bandPeakM(band: TriDepthBand): number {
  if (band.max_m === null) return band.min_m + 0.5;
  return (band.min_m + band.max_m) / 2;
}

/* ── Pourquoi aucune classe de hauteur n'est affichée ? ──

   Quatre situations, une seule formulation chacune, partagée par le panneau,
   la console et le rapport — elles ne peuvent donc plus se contredire :
     · `unavailable`        la source TRI a échoué (une PANNE) ;
     · `in_tri_no_class`    le point EST dans un TRI, aucune hauteur n'y est
                            cartographiée (un quai peut être en TRI sans
                            classe à l'emplacement exact) ;
     · `hors_tri`           le point n'est dans aucun TRI (un FAIT) ;
     · `loading`            la source n'a pas encore répondu — on ne sait
                            rien, et on ne l'affirme pas ;
     · `unknown`            l'appartenance au périmètre n'a pas pu être
                            vérifiée → on ne tranche pas. */
export type TriAbsenceKind =
  | 'loading'
  | 'unavailable'
  | 'in_tri_no_class'
  | 'hors_tri'
  | 'unknown';

/** Classe l'absence de hauteur d'eau officielle en l'une des cinq vérités.
 *  `triFailed` (fetch en échec) prime : une panne n'est jamais une absence.
 *  `tri === null` sans échec = réponse pas encore arrivée (le parent ne met
 *  `floodAlea` à null qu'en chargement ou en panne) → `loading`, jamais un
 *  « hors TRI » fabriqué à partir d'un silence. */
export function triAbsenceKind(
  tri: FloodAleaResult | null,
  triFailed = false
): TriAbsenceKind {
  if (triFailed) return 'unavailable';
  if (!tri) return 'loading';
  if (tri.in_tri === true) return 'in_tri_no_class';
  if (tri.in_tri === false) return 'hors_tri';
  return 'unknown';
}

/** Libellé court + détail pour une des quatre absences (aucune ne dit jamais
 *  « pas de risque » : hors TRI n'est pas « jamais inondé »). */
export function triAbsenceText(kind: TriAbsenceKind): { label: string; detail: string } {
  switch (kind) {
    case 'loading':
      return {
        label: 'Cartographie en cours',
        detail:
          'La classe de hauteur d’eau réglementaire n’est pas encore connue : aucune conclusion n’est tirée tant que la source n’a pas répondu.',
      };
    case 'unavailable':
      return {
        label: 'Service indisponible',
        detail:
          'La cartographie TRI (Géorisques) n’a pas répondu : aucune classe ne peut être affichée. Ce n’est pas une absence de risque.',
      };
    case 'in_tri_no_class':
      return {
        label: 'Dans un TRI, sans classe au point',
        detail:
          'Le point est dans le périmètre d’un Territoire à Risque Important, mais aucune classe de hauteur d’eau n’y est cartographiée. L’exposition réglementaire n’est pas nulle pour autant.',
      };
    case 'hors_tri':
      return {
        label: 'Hors zone TRI',
        detail:
          'Hors zone TRI (Directive Inondation) — aucune classe de hauteur d’eau réglementaire au point. Hors TRI n’est pas « jamais inondé ».',
      };
    default:
      return {
        label: 'Point non cartographié',
        detail:
          'L’appartenance du point au périmètre TRI n’a pas pu être vérifiée : ni classe, ni confirmation « hors TRI ». Ce n’est pas une absence de risque.',
      };
  }
}

/** Libellé de provenance « repère réglementaire » pour l'UI (ou null). */
export function triProvenanceLabel(scen: TriScenario | null): string | null {
  if (!scen || !scen.depth_band) return null;
  const riv = scen.cours_deau ? ` · ${scen.cours_deau}` : '';
  return `Classe officielle ${scen.depth_band.label} (${scen.label}${riv})`;
}
