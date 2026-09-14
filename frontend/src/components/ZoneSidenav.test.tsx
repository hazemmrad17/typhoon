// =============================================================================
//   TYPHOON — ZoneSidenav : mode replié = rail d'icônes SANS libellé.
//   Garde-fou de la règle demandée : replié, la sidenav ne montre que les
//   destinations (Dashboard / Portfolio / Watchlist) sous forme d'icônes —
//   aucun intitulé écrit, et AUCUN dépliage au survol (les intitulés restent
//   accessibles en infobulle). Déplié, les libellés reviennent.
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ZoneSidenav } from './ZoneSidenav';

function renderSidenav(collapsed: boolean) {
  return render(
    <MemoryRouter>
      <ZoneSidenav
        sidenavRef={{ current: null }}
        collapsed={collapsed}
        mobile={false}
        hidden={false}
        theme="dark"
        mode="dark"
        profile="assurance"
        activePath="/watchlist"
        onThemeModeChange={vi.fn()}
        onToggleCollapse={vi.fn()}
        onOpenAccount={vi.fn()}
        onNavigateSettings={vi.fn()}
        onSignOut={vi.fn()}
        onCloseDrawer={vi.fn()}
        onNewDiagnostic={vi.fn()}
        onNavigate={vi.fn()}
      />
    </MemoryRouter>
  );
}

describe('ZoneSidenav — mode replié', () => {
  it('ne rend que les icônes de navigation, sans libellé écrit', () => {
    const { container } = renderSidenav(true);

    expect(container.querySelector('.sidenav-rail')).toBeInTheDocument();
    // Les trois destinations du profil assurance existent — en icônes.
    for (const label of ['Dashboard', 'Portfolio', 'Watchlist']) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
      expect(screen.getByLabelText(label)).toHaveAttribute('title', label);
    }
    // Aucun intitulé écrit dans le DOM : les libellés ne vivent que dans les
    // attributs (aria-label / title), jamais en texte visible. C'est la liste
    // dépliée qui porte les mots — elle n'est pas rendue du tout en rail.
    expect(container.querySelector('.sidenav-nav')).not.toBeInTheDocument();
    expect(container.querySelector('[slot="headline"]')).not.toBeInTheDocument();
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
    expect(screen.queryByText('Watchlist')).not.toBeInTheDocument();
  });

  it("ne se déplie pas au survol", () => {
    const { container } = renderSidenav(true);
    const aside = container.querySelector('.zone-sidenav') as HTMLElement;

    fireEvent.mouseEnter(aside);
    fireEvent.mouseLeave(aside);
    fireEvent.mouseEnter(aside);

    // Aucun « peek » : la classe n'est jamais posée, le rail reste un rail.
    expect(aside.className).not.toContain('sidenav-peek');
    expect(container.querySelector('.sidenav-rail')).toBeInTheDocument();
    expect(screen.queryByText('Watchlist')).not.toBeInTheDocument();
    expect(aside).toHaveAttribute('aria-hidden', 'false');
  });
});

describe('ZoneSidenav — mode déplié', () => {
  it('affiche les libellés et propose de replier', () => {
    const { container } = renderSidenav(false);

    expect(container.querySelector('.sidenav-rail')).not.toBeInTheDocument();
    // Les libellés sont écrits (le stub @material/web du setup clone le slot,
    // d'où plusieurs occurrences du même mot).
    expect(screen.getAllByText('Dashboard').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Watchlist').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Replier le menu')).toBeInTheDocument();
  });
});
