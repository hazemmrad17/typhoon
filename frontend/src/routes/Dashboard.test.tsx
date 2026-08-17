// =============================================================================
//   TYPHOON — /dashboard : test de fumée (vitest + RTL)
//   Vérifie que la page rend les cartes de stats, le tableau des derniers
//   diagnostics, la répartition par bande et la file de validation — à partir
//   d'un cache local seedé, sans aucun appel réseau.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Dashboard } from './Dashboard';

/* Le mapping des routes importe App — on le rend directement. */
const localStorageSeed = (key: string, value: unknown) => {
  localStorage.setItem(key, JSON.stringify(value));
};

function seedCache() {
  const now = Date.now();
  localStorageSeed('typhoon.zone.cache', [
    {
      key: '14 avenue des palmiers 06200 nice',
      report: {
        adresse_saisie: '14 Avenue des Palmiers 06200 Nice',
        adresse_normalisee: '14 Avenue des Palmiers 06200 Nice',
        lat: 43.7,
        lon: 7.26,
        code_insee: '06088',
        date_generation: '2026-08-15',
        alea_count: 1,
        aleas: [
          { code: 'inondation', libelle: 'Inondation', present: true, niveau: 'eleve' },
        ],
        erreurs_partielles: [],
      },
      rapport: null,
      trajectoire: null,
      createdAt: now,
      rapportAt: null,
    },
    {
      key: '2 rue de la lande 37140 bourgueil',
      report: {
        adresse_saisie: '2 Rue de la Lande 37140 Bourgueil',
        adresse_normalisee: '2 Rue de la Lande 37140 Bourgueil',
        lat: 47.28,
        lon: 0.16,
        code_insee: '37031',
        date_generation: '2026-08-09',
        alea_count: 1,
        aleas: [
          { code: 'rga', libelle: 'Retrait-gonflement', present: true, niveau: 'modere' },
        ],
        erreurs_partielles: [],
      },
      rapport: null,
      trajectoire: null,
      createdAt: now - 86400000,
      rapportAt: null,
    },
  ]);
  localStorageSeed('typhoon.watchlist', [
    {
      id: 'wl-1',
      address: '14 Avenue des Palmiers 06200 Nice',
      citycode: '06088',
      lastSeenCatNat: 3,
      addedAt: now,
    },
  ]);
  localStorageSeed('typhoon.watchlist.latestCatNat', {
    '14 avenue des palmiers 06200 nice': 3,
  });
}

describe('Dashboard', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    seedCache();
  });

  it('renders stat cards with real counts', () => {
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    );
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    // 2 diagnostics cachés, 1 en bande Élevé → « À expertiser » = 1
    expect(screen.getAllByText('Diagnostics').length).toBeGreaterThan(0);
    expect(screen.getAllByText('À expertiser').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Adresses suivies').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Nouveaux CatNat').length).toBeGreaterThan(0);
    // La valeur « 2 » des diagnostics apparaît (2 entrées seedées).
    expect(screen.getAllByText('2').length).toBeGreaterThan(0);
  });

  it('renders the recent diagnostics table with seeded addresses', () => {
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    );
    expect(screen.getByText('Derniers diagnostics')).toBeInTheDocument();
    expect(screen.getByText('14 Avenue des Palmiers 06200 Nice')).toBeInTheDocument();
    expect(screen.getByText('2 Rue de la Lande 37140 Bourgueil')).toBeInTheDocument();
    // Bande Élevé détectée pour la première adresse (pastille D03).
    expect(screen.getAllByText('Élevé').length).toBeGreaterThan(0);
  });

  it('renders the D03 band distribution and validation queue', () => {
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    );
    expect(screen.getByText('Répartition par bande D03')).toBeInTheDocument();
    expect(screen.getByText('File de validation')).toBeInTheDocument();
    expect(screen.getByText('Voir la watchlist')).toBeInTheDocument();
  });

  it('supports searching the diagnostics table', async () => {
    const { userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    );
    const search = screen.getByRole('searchbox', { name: 'Rechercher une adresse' });
    await user.type(search, 'Nice');
    expect(screen.getByText('14 Avenue des Palmiers 06200 Nice')).toBeInTheDocument();
    expect(screen.queryByText('2 Rue de la Lande 37140 Bourgueil')).not.toBeInTheDocument();
  });
});
