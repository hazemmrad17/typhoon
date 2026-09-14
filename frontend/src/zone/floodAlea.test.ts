// =============================================================================
//   TYPHOON — floodAlea : repère réglementaire TRI côté UI.
//
//   Ces tests verrouillent le calage scénario UI ↔ scénario réglementaire et
//   le fait que la profondeur « dérivée » reste explicitement du modèle :
//   sans classe TRI, aucune profondeur officielle n'existe et le moteur garde
//   son enveloppe synthétique — jamais un nombre qui n'existe pas.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { SCENARIOS } from './damageModel';
import {
  SCENARIO_TRI_KEY,
  UI_SCENARIO_TRI_KEY,
  triScenarioKeyFor,
  triDepthForScenario,
  bandPeakM,
  triProvenanceLabel,
  triAbsenceKind,
  triAbsenceText,
  type FloodAleaResult,
  type TriScenario,
} from './floodAlea';

function triResult(
  scen: Array<Partial<TriScenario> & { key: TriScenario['key'] }>,
  available = true,
  /** Appartenance au périmètre TRI (`ms:LIMITETRI`) — null = non vérifiée. */
  inTri: boolean | null = false
): FloodAleaResult {
  return {
    available,
    reason: available ? null : 'hors TRI',
    in_tri: available ? true : inTri,
    resolution: 'per-building',
    scenarios: scen.map((s) => ({
      label: s.label ?? s.key,
      present: s.present ?? false,
      depth_band: s.depth_band ?? null,
      cours_deau: s.cours_deau ?? null,
      id_tri: s.id_tri ?? null,
      key: s.key,
    })) as FloodAleaResult['scenarios'],
    source: 'test',
    source_url: null,
    retrieved_at: '2026-09-14T00:00:00+00:00',
  };
}

/* SCN-001 — une seule source de vérité : les clés UI sont les clés TRI.
   Régression verrouillée : l'ancienne table ne résolvait AUCUNE clé UI vers
   une classe (extreme → undefined → carte sèche). */
describe('SCN-001 — clés scénario UI = clés réglementaires TRI', () => {
  it('résout chaque clé du moteur vers sa propre classe TRI', () => {
    for (const s of SCENARIOS) {
      expect(triScenarioKeyFor(s.key)).not.toBeNull();
      expect(SCENARIO_TRI_KEY[s.key]).toBeTruthy();
    }
    expect(triScenarioKeyFor('extreme')).toBe('extreme');
    expect(triScenarioKeyFor('moyen')).toBe('moyen');
    expect(triScenarioKeyFor('frequent')).toBe('frequent');
    expect(triScenarioKeyFor('faible')).toBe('faiable');
  });

  it('couvre TOUTES les clés du moteur (aucune sélection ne tombe à vide)', () => {
    for (const s of SCENARIOS) {
      expect(SCENARIO_TRI_KEY[s.key]).toBeDefined();
    }
  });

  it('accepte encore les anciennes clés comme dépréciées', () => {
    expect(UI_SCENARIO_TRI_KEY.direct).toBe('extreme');
    expect(UI_SCENARIO_TRI_KEY.west).toBe('moyen');
    expect(UI_SCENARIO_TRI_KEY.east).toBe('frequent');
    expect(UI_SCENARIO_TRI_KEY.offshore).toBe('faiable');
  });
});

describe('triDepthForScenario — la classe TRI remplace la profondeur du moteur', () => {
  const tri = triResult([
    { key: 'frequent', present: true, depth_band: { min_m: 0, max_m: 0.5, label: '0 – 0,5 m' } },
    { key: 'moyen', present: true, depth_band: { min_m: 0.5, max_m: 1, label: '0,5 – 1 m' } },
    { key: 'extreme', present: false, depth_band: null },
    { key: 'faiable', present: false, depth_band: null },
  ]);

  it('retourne la classe du scénario sélectionné (clé UI, SCN-001)', () => {
    const scen = triDepthForScenario(tri, 'moyen');
    expect(scen?.depth_band?.min_m).toBe(0.5);
    expect(scen?.depth_band?.max_m).toBe(1);
  });

  it('résout aussi les anciennes clés (compatibilité dépréciée)', () => {
    expect(triDepthForScenario(tri, 'west')?.depth_band?.min_m).toBe(0.5);
  });

  it('ne retourne rien pour un scénario non cartographié au point', () => {
    expect(triDepthForScenario(tri, 'extreme')).toBeNull();
    expect(triDepthForScenario(tri, 'direct')).toBeNull();
  });

  it('ne retourne rien pour une clé inconnue (jamais d\'invention)', () => {
    expect(triDepthForScenario(tri, 'zzz')).toBeNull();
    expect(triScenarioKeyFor('zzz')).toBeNull();
  });

  it('ne retourne rien hors TRI (available=false) — jamais d\'invention', () => {
    expect(triDepthForScenario(triResult([], false), 'moyen')).toBeNull();
    expect(triDepthForScenario(null, 'moyen')).toBeNull();
  });

  it('trait present=null (service indisponible) comme absent', () => {
    const t = triResult([{ key: 'moyen', present: null, depth_band: null }]);
    expect(triDepthForScenario(t, 'moyen')).toBeNull();
  });
});

describe('bandPeakM — profondeur dérivée de la classe (du MODÈLE, pas un fait)', () => {
  it('classe fermée → milieu de classe', () => {
    expect(bandPeakM({ min_m: 0, max_m: 0.5, label: '' })).toBe(0.25);
    expect(bandPeakM({ min_m: 0.5, max_m: 1, label: '' })).toBe(0.75);
    expect(bandPeakM({ min_m: 1, max_m: 2, label: '' })).toBe(1.5);
  });

  it('bande ouverte « ≥ X » → X + 0,5 m (choix affiché)', () => {
    expect(bandPeakM({ min_m: 2, max_m: null, label: '' })).toBe(2.5);
  });
});

describe('triProvenanceLabel — la provenance reste la classe d\'origine', () => {
  it('cite la classe, le scénario et le cours d\'eau', () => {
    const scen = {
      key: 'moyen' as const,
      label: 'Moyen (~100 ans)',
      present: true,
      depth_band: { min_m: 0.5, max_m: 1, label: '0,5 – 1 m' },
      cours_deau: 'loup',
      id_tri: 'FR05201',
    };
    expect(triProvenanceLabel(scen)).toContain('0,5 – 1 m');
    expect(triProvenanceLabel(scen)).toContain('Moyen (~100 ans)');
    expect(triProvenanceLabel(scen)).toContain('loup');
  });

  it('rien sans classe', () => {
    expect(triProvenanceLabel(null)).toBeNull();
  });
});

/* Une seule absence ne doit jamais se dire comme une autre : des quais
   réellement en TRI (Orléans, Lyon) rendaient « hors TRI » faute de classe au
   point, et un silence de chargement n'est pas davantage un hors-TRI. */
describe('triAbsenceKind / triAbsenceText — cinq vérités distinctes', () => {
  it('départage panne, silence, dans un TRI, hors TRI et non vérifié', () => {
    expect(triAbsenceKind(null, true)).toBe('unavailable');
    expect(triAbsenceKind(null, false)).toBe('loading');
    expect(triAbsenceKind(triResult([], false, true))).toBe('in_tri_no_class');
    expect(triAbsenceKind(triResult([], false, false))).toBe('hors_tri');
    expect(triAbsenceKind(triResult([], false, null))).toBe('unknown');
  });

  it('une PANNE prime : jamais traduite en absence de risque', () => {
    const failed = triAbsenceText(triAbsenceKind(triResult([], false, false), true));
    expect(failed.label).toMatch(/indisponible/i);
    expect(failed.detail).toMatch(/n’a pas répondu/);
    expect(failed.detail).not.toMatch(/hors TRI/i);
  });

  it('« dans un TRI sans classe » ne se confond pas avec « hors TRI »', () => {
    const inTri = triAbsenceText('in_tri_no_class');
    const hors = triAbsenceText('hors_tri');
    expect(inTri.label).toMatch(/sans classe/i);
    expect(hors.label).toMatch(/hors zone tri/i);
    expect(inTri.detail).not.toBe(hors.detail);
  });

  it('les trois absences incertaines portent toutes le garde-fou de sens', () => {
    for (const kind of ['loading', 'unavailable', 'in_tri_no_class', 'hors_tri', 'unknown'] as const) {
      expect(triAbsenceText(kind).label.length).toBeGreaterThan(0);
      expect(triAbsenceText(kind).detail.length).toBeGreaterThan(0);
    }
    /* Hors TRI n’est pas « jamais inondé » — le rappel est explicite. */
    expect(triAbsenceText('hors_tri').detail).toMatch(/jamais inondé/i);
  });
});
