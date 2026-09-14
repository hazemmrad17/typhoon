// =============================================================================
//   TYPHOON — FloodConsole : la timeline reste visible, mais inerte, sans adresse.
//
//   Trois garde-fous :
//     1. la timeline n'est montée QU'AVEC une carte métrique active — c'est la
//        carte qui décide de la couche affichée, la timeline qui la date ;
//     2. si l'adresse est retirée alors qu'une carte restait allumée, elle
//        reste montée mais inerte (.is-locked) et la lecture est `disabled` ;
//     3. aucune chip « Entrez d'abord une adresse » ne vient se poser sur la
//        console ; cette aide reste dans les infobulles des commandes.
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { FloodConsole } from './FloodConsole';

const base = {
  selectedMetric: 'wind',
  onMetricChange: vi.fn(),
  onTimeChange: vi.fn(),
};

describe('FloodConsole — timeline inerte sans adresse', () => {
  it('reste montée mais verrouillée tant qu’aucune adresse n’est diagnostiquée', () => {
    const { container } = render(<FloodConsole {...base} locked />);

    const timeline = container.querySelector('.flood-timeline');
    expect(timeline).not.toBeNull();
    expect(timeline?.classList.contains('is-locked')).toBe(true);

    // Les trois pièces de l'instrument sont là — c'est la règle.
    expect(container.querySelector('.flood-date-field')).not.toBeNull();
    expect(container.querySelector('.flood-scale')).not.toBeNull();

    // Mais aucune n'est manœuvrable.
    const play = container.querySelector<HTMLButtonElement>('.flood-play');
    expect(play).not.toBeNull();
    expect(play?.disabled).toBe(true);

    // Les 4 cartes météo restent en place et verrouillées, sans chip
    // d'explication par-dessus la console (l'aide vit dans les infobulles).
    expect(container.querySelectorAll('.flood-card--locked')).toHaveLength(4);
    expect(container.querySelector('.flood-lock-hint')).toBeNull();
    expect(container.textContent).not.toContain("Entrez d'abord une adresse");
    expect(container.querySelector<HTMLButtonElement>('.flood-play')?.getAttribute('title')).toContain(
      "Entrez d'abord une adresse"
    );
  });

  it('n’est pas montée quand aucune carte métrique n’est active', () => {
    const { container } = render(<FloodConsole {...base} selectedMetric="" />);

    expect(container.querySelector('.flood-timeline')).toBeNull();
    expect(container.querySelector('.flood-date-field')).toBeNull();
    expect(container.querySelector('.flood-play')).toBeNull();
    expect(container.querySelector('.flood-scale')).toBeNull();

    // Les 4 cartes restent : ce sont elles qui ouvrent la timeline.
    expect(container.querySelectorAll('.flood-card')).toHaveLength(4);
  });

  it('s’ouvre avec la carte active et se referme quand on la coupe', () => {
    const onMetricChange = vi.fn();
    const { container, rerender } = render(
      <FloodConsole {...base} selectedMetric="" onMetricChange={onMetricChange} />
    );
    expect(container.querySelector('.flood-timeline')).toBeNull();

    // Clic sur « Wind » (2e carte) → la carte réclame la couche météo.
    const wind = container.querySelectorAll<HTMLButtonElement>('.flood-card')[1];
    fireEvent.click(wind);
    expect(onMetricChange).toHaveBeenLastCalledWith('wind');

    // Le parent applique la sélection → la timeline apparaît.
    rerender(<FloodConsole {...base} selectedMetric="wind" onMetricChange={onMetricChange} />);
    expect(container.querySelector('.flood-timeline')).not.toBeNull();

    // Un second clic coupe la couche → le parent remet la métrique à vide.
    fireEvent.click(container.querySelectorAll<HTMLButtonElement>('.flood-card')[1]);
    expect(onMetricChange).toHaveBeenLastCalledWith('');

    rerender(<FloodConsole {...base} selectedMetric="" onMetricChange={onMetricChange} />);
    expect(container.querySelector('.flood-timeline')).toBeNull();
  });

  it('est pleinement active une fois l’adresse diagnostiquée', () => {
    const { container } = render(<FloodConsole {...base} />);

    const timeline = container.querySelector('.flood-timeline');
    expect(timeline).not.toBeNull();
    expect(timeline?.classList.contains('is-locked')).toBe(false);

    expect(container.querySelector<HTMLButtonElement>('.flood-play')?.disabled).toBe(false);
    expect(container.querySelectorAll('.flood-card--locked')).toHaveLength(0);
    expect(container.querySelector('.flood-lock-hint')).toBeNull();
  });
});
