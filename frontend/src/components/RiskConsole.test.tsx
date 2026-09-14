// =============================================================================
//   TYPHOON — RiskConsole : la règle temporelle de la simulation reste montée.
//
//   Garde-fous :
//     1. la piste (lecture, vitesse, histogramme) reste l'instrument de l'étape 2 ;
//     2. la simulation est pilotée par la PLUIE RÉELLE Open-Meteo × la CLASSE
//        TRI — sans ces deux entrées, la console affiche explicitement
//        l'indisponibilité et ne dessine rien (jamais de profil inventé).
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { RiskConsole } from './RiskConsole';
import type { MeteoData } from '../zone/hydroRoute';

const METEO_RAIN: MeteoData = {
  lat: 43.7,
  lon: 7.27,
  rain_hourly: Array.from({ length: 24 }, (_, h) => ({
    t: `2026-09-14T${String(h).padStart(2, '0')}:00:00`,
    v: h === 14 ? 10 : h === 15 ? 5 : 1,
  })),
  rain_total_mm: 36,
  dry: false,
  sources: { rain: 'Open-Meteo' },
};

const props = {
  report: null,
  timeMin: 195,
  onTimeChange: vi.fn(),
  meteo: METEO_RAIN,
  triPeak: 1.1,
  triLabel: 'Classe officielle 1 – 2 m (extrême)',
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

  it("affiche la bande de suivi (compteur d'eau + référence)", () => {
    const { container } = render(<RiskConsole {...props} />);

    expect(container.querySelector('.risk-console-status')).not.toBeNull();
    // Un seul compteur : la hauteur d'eau de la simulation (pluie réelle × TRI).
    expect(container.querySelectorAll('.risk-console-stat')).toHaveLength(1);
  });
});

describe("RiskConsole — simulation pilotée par les données réelles", () => {
  const waterStat = (c: HTMLElement) =>
    c.querySelectorAll<HTMLElement>('.risk-console-stat')[0];

  it("avec pluie réelle + classe TRI : la hauteur d'eau suit l'accumulation", () => {
    /* 08:00 : ~9 h de pluie cumulée sur 36 mm → ~0,3 × pic 1,1 m ≈ 0,34 m …
       on vérifie surtout que le compteur est un nombre, pas « — ». */
    const { container } = render(<RiskConsole {...props} timeMin={480} />);
    const stat = waterStat(container);

    expect(stat.textContent).toMatch(/\d\.\d{2}/);
    expect(stat.textContent).not.toContain('—');
  });

  /* Journée sèche : le SCÉNARIO reste visible (classe officielle = fait) et la
     console dit explicitement que la FORME de la montée est une hypothèse.
     Avant, seule la pluie du jour pouvait produire de l'eau : choisir
     « EXTREME » par temps sec n'affichait rien et se lisait comme une panne. */
  it('sans pluie prévue : le niveau du scénario s’affiche, la montée est déclarée hypothèse', () => {
    const { container } = render(<RiskConsole {...props} meteo={null} />);
    const stat = waterStat(container);

    expect(stat.textContent).toMatch(/\d\.\d{2}/);
    expect(stat.textContent).toContain('hypothèse');
    expect(stat.textContent).toContain('aucune pluie prévue');
  });

  it('hors TRI (pas de pic officiel) : indisponibilité explicite', () => {
    const { container } = render(<RiskConsole {...props} triPeak={null} />);
    const stat = waterStat(container);

    expect(stat.textContent).toContain('Simulation indisponible');
    expect(stat.textContent).toContain('—');
  });
});

// SCN-011 — « Play scenario » déroule la journée jusqu'au PIC de la prévision
// réelle puis s'arrête (pas de boucle silencieuse), et reste inactif sans
// simulation.
describe('SCN-011 — Play scenario piloté par le pic réel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const playButton = (c: HTMLElement) =>
    c.querySelector<HTMLButtonElement>('.risk-console-play')!;

  it('est désactivé sans classe TRI au point', () => {
    const { container } = render(<RiskConsole {...props} triPeak={null} />);
    expect(playButton(container).disabled).toBe(true);
  });

  it('reste actif sans pluie prévue : le scénario pilote le niveau', () => {
    const { container } = render(<RiskConsole {...props} meteo={null} />);
    expect(playButton(container).disabled).toBe(false);
  });

  it('avance l\u2019heure jusqu\u2019au pic de pluie puis se met en pause', () => {
    /* Pic à 14 h (index 14) → minute cible 840. Départ à 195 min. */
    const onTimeChange = vi.fn();
    const { container } = render(<RiskConsole {...props} onTimeChange={onTimeChange} />);

    fireEvent.click(playButton(container));
    /* La lecture appelle onTimeChange avec un updater (m) => … */
    for (let i = 0; i < 60; i += 1) {
      act(() => {
        vi.advanceTimersByTime(700);
      });
    }

    const calls = onTimeChange.mock.calls;
    const updater = calls[calls.length - 1]?.[0];
    expect(typeof updater).toBe('function');
    const last = (updater as (m: number) => number)(840 - 15);
    expect(last).toBe(840);
  });

  it('repart de minuit si le curseur est déjà au-delà du pic', () => {
    const onTimeChange = vi.fn();
    const { container } = render(
      <RiskConsole {...props} timeMin={1200} onTimeChange={onTimeChange} />
    );

    fireEvent.click(playButton(container));

    expect(onTimeChange).toHaveBeenCalledWith(0);
  });
});
