// =============================================================================
//   VFX-002 — disclaimer du mode VFX (constitution §2.1).
//
//   Le libellé principal est obligatoire dès que le mode VFX est actif ; le
//   libellé « données partielles » n'apparaît que quand un repli illustratif
//   alimente le rendu. Rien de tout cela n'existe en mode data — le composant
//   n'y est simplement pas rendu (cf. le rendu conditionnel de `Zone.tsx`).
// =============================================================================

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VfxDisclaimer } from './VfxDisclaimer';

describe('VFX-002 — VfxDisclaimer', () => {
  it('affiche toujours le libellé principal « non contractuelle »', () => {
    render(<VfxDisclaimer partial={false} source="forecast" />);
    expect(screen.getByText('Simulation visuelle — non contractuelle')).toBeDefined();
  });

  it('affiche le libellé secondaire quand les entrées sont partielles', () => {
    render(<VfxDisclaimer partial source="fallback" />);
    expect(screen.getByText(/Données partielles — rendu illustratif/)).toBeDefined();
  });

  it('n’affiche pas « données partielles » avec des entrées réelles complètes', () => {
    render(<VfxDisclaimer partial={false} source="forecast" />);
    expect(screen.queryByText(/Données partielles/)).toBeNull();
    expect(screen.getByText(/prévision réelle/)).toBeDefined();
  });

  it('annonce l’absence d’ancrage réglementaire plutôt que de la masquer', () => {
    render(<VfxDisclaimer partial source="none" />);
    expect(screen.getByText(/aucune classe TRI au point/)).toBeDefined();
  });

  it('décrit la montée illustrée quand seule la forme est hypothétique', () => {
    render(<VfxDisclaimer partial source="fallback" />);
    expect(screen.getByText(/rampe documentée/)).toBeDefined();
  });
});
