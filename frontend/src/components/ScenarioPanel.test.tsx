// =============================================================================
//   TYPHOON — ScenarioPanel : les vignettes portent la photo RÉELLE du secteur.
//
//   Garde-fou de la règle demandée : chaque carte de la grille est adossée à la
//   photo terrain du secteur (Panoramax), avec sa provenance affichée sous la
//   grille — et quand le fonds ne couvre pas le point, AUCUNE image n'est
//   substituée : les cartes gardent leur visuel abstrait et le panneau le dit.
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { ScenarioPanel } from './ScenarioPanel';
import type { SitePhoto } from '../zone/sitePhoto';

const PHOTO: SitePhoto = {
  available: true,
  reason: null,
  label: null,
  candidates: 24,
  id: 'e6599eff-7c40-4afd-ac85-e0a7b466da7a',
  distance_m: 9.3,
  facing_ok: false,
  facing_error_deg: 100.4,
  view_azimuth: 30,
  captured_at: '2024-07-10T14:03:08.163000+02:00',
  thumb_url: 'https://panoramax.ign.fr/api/pictures/e6599eff/thumb.jpg',
  sd_url: 'https://panoramax.ign.fr/api/pictures/e6599eff/sd.jpg',
  page_url: 'https://api.panoramax.xyz/#focus=pic&pic=e6599eff',
  producer: 'immergis',
  licence: 'etalab-2.0',
  source: 'Panoramax (IGN / DINUM) — photos terrain, licence etalab-2.0',
  retrieved_at: '2026-09-13T00:00:00+00:00',
};

function renderPanel(photo: SitePhoto | null) {
  return render(
    <ScenarioPanel
      place="10 Rue de la Paix 75002 Paris"
      report={null}
      scenarioKey="direct"
      onScenarioChange={vi.fn()}
      timeMin={195}
      photo={photo}
    />
  );
}

describe('ScenarioPanel — vignettes des scénarios', () => {
  it('adosse chaque carte à la photo terrain du secteur', () => {
    const { container } = renderPanel(PHOTO);

    const cards = container.querySelectorAll('.scenario-card');
    expect(cards).toHaveLength(8);
    expect(container.querySelectorAll('.scenario-card-photo')).toHaveLength(8);
    expect(container.querySelectorAll('.scenario-card.has-photo')).toHaveLength(8);

    const img = container.querySelector<HTMLImageElement>('.scenario-card-photo');
    expect(img?.getAttribute('src')).toBe(PHOTO.thumb_url);
  });

  it('affiche la provenance de la photo (etalab-2.0 exige la source)', () => {
    const { container } = renderPanel(PHOTO);

    const credit = container.querySelector('.scenario-photo-credit');
    expect(credit?.textContent).toContain('Panoramax');
    expect(credit?.textContent).toContain('immergis');
    expect(credit?.textContent).toContain('etalab-2.0');
    expect(credit?.querySelector('a')?.getAttribute('href')).toBe(PHOTO.page_url);
    // L'orientation non vérifiée n'est pas annoncée comme un fait.
    expect(credit?.textContent).toContain('la plus proche du point');
    expect(credit?.getAttribute('title')).toContain('100');
  });

  it('ne substitue aucune image quand le secteur n’est pas couvert', () => {
    const { container } = renderPanel({
      ...PHOTO,
      available: false,
      reason: 'no_coverage',
      label: 'Aucune photo Panoramax dans un rayon de 60 m autour du point.',
      thumb_url: null,
      page_url: null,
      licence: null,
    });

    expect(container.querySelectorAll('.scenario-card-photo')).toHaveLength(0);
    expect(container.querySelectorAll('.scenario-card.has-photo')).toHaveLength(0);
    expect(container.querySelector('.scenario-photo-credit.is-empty')?.textContent).toContain(
      'Aucune photo Panoramax'
    );
  });

  it('ne dit rien tant que la photo n’est pas chargée', () => {
    const { container } = renderPanel(null);

    expect(container.querySelectorAll('.scenario-card')).toHaveLength(8);
    expect(container.querySelector('.scenario-card-photo')).toBeNull();
    expect(container.querySelector('.scenario-photo-credit')).toBeNull();
  });
});
