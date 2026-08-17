// =============================================================================
//   TYPHOON — /portfolio : test de fumée (vitest + RTL)
//   Vérifie le rendu de la page sans lot : header, zone de dépôt CSV,
//   état vide. Ne soumet aucun lot (pas de fetch).
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Portfolio } from './Portfolio';

describe('Portfolio', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('renders header + dropzone + empty state without a batch', () => {
    render(
      <MemoryRouter>
        <Portfolio />
      </MemoryRouter>
    );
    expect(screen.getByRole('heading', { name: 'Portfolio' })).toBeInTheDocument();
    // Zone de dépôt CSV.
    expect(screen.getByText('Déposer un fichier CSV')).toBeInTheDocument();
    expect(screen.getByText(/Ou cliquez pour parcourir/)).toBeInTheDocument();
    // État vide.
    expect(screen.getByText('Aucun lot chargé')).toBeInTheDocument();
  });
});
