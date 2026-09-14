// =============================================================================
//   exposure — l'échelle d'un fait borne son libellé.
//
//   Régression : le rapport affichait sur la MÊME fiche « à mon adresse » ET
//   « Résolution : estimation communale ». Un zonage sismique national ou un
//   comptage ICPE communal ne sont pas des faits au bâtiment. Le libellé est
//   désormais DÉRIVÉ de la résolution, jamais de `present` seul.
// =============================================================================

import { describe, expect, it } from 'vitest';
import { exposureClass, exposureOf } from './exposure';
import type { AleaDetail } from './config';

function alea(over: Partial<AleaDetail>): AleaDetail {
  return {
    code: 'x',
    libelle: 'X',
    present: null,
    present_commune: null,
    resolution: null,
    ...over,
  };
}

describe('exposureOf — le libellé suit la RÉSOLUTION', () => {
  it('per-building + concerné → « à l’adresse »', () => {
    const e = exposureOf(
      alea({ present: true, resolution: 'per-building' })
    );
    expect(e.level).toBe('adresse');
    expect(e.label).toBe('à l’adresse');
    expect(e.identified).toBe(true);
  });

  it('échelle communale + concerné → JAMAIS « à l’adresse »', () => {
    /* C'est le cas réel d'un zonage sismique ou d'un comptage ICPE. */
    const regulier = exposureOf(
      alea({ present: true, resolution: 'commune-level' })
    );
    expect(regulier.level).toBe('commune');
    expect(regulier.label).not.toMatch(/adresse/i);

    const estime = exposureOf(
      alea({ present: true, resolution: 'commune-level-estimate' })
    );
    expect(estime.level).toBe('commune');
    expect(estime.label).not.toMatch(/adresse/i);
  });

  it('per-building mais seulement communal (présent_commune) → « communale »', () => {
    const e = exposureOf(
      alea({ present: false, present_commune: true, resolution: 'per-building' })
    );
    expect(e.level).toBe('commune');
  });

  it('non concerné → « non recensé », jamais identifié', () => {
    const e = exposureOf(alea({ present: false, resolution: 'per-building' }));
    expect(e.level).toBe('absent');
    expect(e.identified).toBe(false);
  });

  it('source en échec → « statut inconnu », JAMAIS « absent »', () => {
    /* Une panne n'est pas une absence de risque : c'est un fait différent. */
    const e = exposureOf(alea({ erreur: 'WFS indisponible' }));
    expect(e.level).toBe('inconnu');
    expect(e.identified).toBe(false);
    expect(e.label).toMatch(/inconnu/i);
  });

  it('expose l’échelle réelle dans tous les cas (transparence §2)', () => {
    expect(exposureOf(alea({ resolution: 'per-building' })).resolutionLabel).toMatch(/bâtiment/i);
    expect(exposureOf(alea({ resolution: 'commune-level' })).resolutionLabel).toMatch(/communal/i);
    expect(exposureOf(alea({ resolution: 'commune-level-estimate' })).resolutionLabel).toMatch(/estimation/i);
    /* Résolution absente : on l'avoue, on ne suppose pas une échelle. */
    expect(exposureOf(alea({})).resolutionLabel).toMatch(/non précisée/i);
  });

  it('classe CSS par niveau (pastilles de la synthèse)', () => {
    expect(exposureClass('adresse')).toBe('st-adresse');
    expect(exposureClass('commune')).toBe('st-commune');
    expect(exposureClass('absent')).toBe('st-absent');
    expect(exposureClass('inconnu')).toBe('st-inconnu');
  });
});
