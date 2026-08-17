// =============================================================================
//   TYPHOON — /watchlist : test de fumée (vitest + RTL)
//   Vérifie le rendu de la page avec des entrées seedées (cartes + badge) et
//   l'état vide. Aucun appel réseau.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { WatchlistPage } from './WatchlistPage';

describe('WatchlistPage', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('renders the empty state when no entries', () => {
    render(
      <MemoryRouter>
        <WatchlistPage />
      </MemoryRouter>
    );
    expect(screen.getByRole('heading', { name: 'Watchlist' })).toBeInTheDocument();
    expect(screen.getByText('Watchlist vide')).toBeInTheDocument();
  });

  it('renders entries as cards with INSEE and a remove button', () => {
    localStorage.setItem(
      'typhoon.watchlist',
      JSON.stringify([
        {
          id: 'wl-1',
          address: '14 Avenue des Palmiers 06200 Nice',
          citycode: '06088',
          lastSeenCatNat: 3,
          addedAt: Date.now(),
        },
      ])
    );
    localStorage.setItem(
      'typhoon.watchlist.latestCatNat',
      JSON.stringify({ '14 avenue des palmiers 06200 nice': 3 })
    );
    render(
      <MemoryRouter>
        <WatchlistPage />
      </MemoryRouter>
    );
    expect(screen.getByText('14 Avenue des Palmiers 06200 Nice')).toBeInTheDocument();
    // « INSEE 06088 » est rendu dans un seul span.
    expect(screen.getByText('INSEE 06088')).toBeInTheDocument();
    expect(screen.getByText('Diagnostiquer')).toBeInTheDocument();
    // md-icon-button est un custom element — on cible l'attribut aria-label.
    expect(
      screen.getByLabelText('Retirer 14 Avenue des Palmiers 06200 Nice de la watchlist')
    ).toBeInTheDocument();
  });
});
