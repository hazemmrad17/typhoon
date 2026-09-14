// =============================================================================
//   TYPHOON — RiskConsole : la règle temporelle de la simulation reste montée.
//
//   Garde-fou : cette piste (lecture, vitesse, axe horaire de pluie du scénario)
//   est l'instrument de l'étape 2 — elle ne doit pas disparaître de la console.
//   L'accès à l'étape 2 est conditionné au diagnostic par le stepper (Zone) ;
//   ce n'est donc pas à la console de masquer sa propre commande.
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { RiskConsole } from './RiskConsole';

const props = {
  report: null,
  scenarioKey: 'direct',
  timeMin: 195,
  onTimeChange: vi.fn(),
  meteo: null,
};

describe('RiskConsole — règle temporelle', () => {
  it('reste montée : lecture, vitesse et axe horaire', () => {
    const { container } = render(<RiskConsole {...props} />);

    expect(container.querySelector('.risk-console-timeline')).not.toBeNull();
    expect(container.querySelector('.risk-console-play')).not.toBeNull();
    expect(container.querySelector('.risk-console-rate')).not.toBeNull();
    expect(container.querySelector('.risk-console-scale')).not.toBeNull();
    expect(container.querySelector('[role="slider"]')).not.toBeNull();
  });

  it('affiche la bande de suivi (compteurs + référence)', () => {
    const { container } = render(<RiskConsole {...props} />);

    expect(container.querySelector('.risk-console-status')).not.toBeNull();
    expect(container.querySelectorAll('.risk-console-stat')).toHaveLength(3);
  });
});

describe("RiskConsole — enveloppe d'eau (même source que le volume peint)", () => {
  const waterStat = (c: HTMLElement) =>
    c.querySelectorAll<HTMLElement>('.risk-console-stat')[0];

  it('nomme la bande de couleur du volume dessiné sur la carte', () => {
    /* 14:00 : le cumul du scénario « direct » porte l’enveloppe à 0,68 m,
       donc dans la bande 0,5 – 1,0 m — celle que la carte peint. */
    const { container } = render(<RiskConsole {...props} timeMin={840} />);
    const stat = waterStat(container);

    expect(stat.textContent).toContain('0.68');
    expect(stat.textContent).toContain('0,5 – 1,0 m');
    expect(stat.style.getPropertyValue('--risk-c').trim()).toBe('#2f7fd6');
  });

  it('dit explicitement quand rien n’est peint (sous le seuil du moteur)', () => {
    /* 03:15 : 0,08 m, sous le seuil d’infrastructure — le moteur ne compte
       aucun dommage, la carte ne peint aucune eau : le compteur doit le dire
       plutôt que d’afficher une bande. */
    const { container } = render(<RiskConsole {...props} timeMin={195} />);
    const stat = waterStat(container);

    expect(stat.textContent).toContain('Sous le seuil du moteur (0,3 m)');
    expect(container.querySelector('.risk-console-stat-band i')).not.toBeNull();
  });
});
