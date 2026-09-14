// =============================================================================
//   TYPHOON — ScenarioPanel : les vignettes portent la photo RÉELLE du secteur.
//
//   Garde-fou de la règle demandée : chaque carte de la grille est adossée à la
//   photo terrain du secteur (Panoramax), avec sa provenance affichée sous la
//   grille — et quand le fonds ne couvre pas le point, AUCUNE image n'est
//   substituée : les cartes gardent leur visuel abstrait et le panneau le dit.
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ScenarioPanel } from './ScenarioPanel';
import type { SitePhoto } from '../zone/sitePhoto';
import type { RisqueReport } from '../zone/config';
import type { FloodAleaResult } from '../zone/floodAlea';

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

  it('affiche le statut RÉEL de l’aléa du diagnostic (feu, RGA, séisme, mvt)', () => {
    const report = {
      aleas: [
        { code: 'feu_foret', libelle: 'Feux de forêt', present: true, zonage: 'Dans un périmètre PPR feu de forêt', resolution: 'per-building' },
        { code: 'rga', libelle: 'Retrait-gonflement des argiles', present: false, zonage: 'Aléa non recensé' },
        { code: 'sismicite', libelle: 'Séisme', present: true, zonage: 'Zone sismique 2 — sismicité faible', zone_sismique: '2' },
        { code: 'mouvement_terrain', libelle: 'Mouvements de terrain', present: null, erreur: 'source Géorisques indisponible' },
      ],
    } as unknown as RisqueReport;

    const { rerender } = render(
      <ScenarioPanel place="x" report={report} scenarioKey="direct" onScenarioChange={vi.fn()} timeMin={195} photo={null} hazardEvent="FIRE" />
    );
    /* Le statut porte désormais l'ÉCHELLE réelle de la donnée : plus de
       « à mon adresse » collé sur une estimation communale (cf. zone/exposure). */
    expect(screen.getByText(/exposé — à l’adresse/i)).toBeTruthy();
    expect(screen.getByText(/périmètre PPR feu/i)).toBeTruthy();
    expect(screen.getByText(/testé au bâtiment/i)).toBeTruthy();

    rerender(
      <ScenarioPanel place="x" report={report} scenarioKey="direct" onScenarioChange={vi.fn()} timeMin={195} photo={null} hazardEvent="RGA" />
    );
    expect(screen.getByText(/non exposé au point/i)).toBeTruthy();

    rerender(
      <ScenarioPanel place="x" report={report} scenarioKey="direct" onScenarioChange={vi.fn()} timeMin={195} photo={null} hazardEvent="SEISMIC" />
    );
    expect(screen.getByText(/Zone sismique 2/i)).toBeTruthy();

    rerender(
      <ScenarioPanel place="x" report={report} scenarioKey="direct" onScenarioChange={vi.fn()} timeMin={195} photo={null} hazardEvent="MVT" />
    );
    expect(screen.getByText(/statut inconnu/i)).toBeTruthy();
    expect(screen.getByText(/source Géorisques indisponible/i)).toBeTruthy();
  });
});

// SCN-003 — l'absence de classe TRI recouvre QUATRE vérités distinctes, et
// chacune doit se dire avec ses mots :
//   · le point est dans un TRI, mais sans classe à cet endroit (un quai) ;
//   · le point n'est dans aucun TRI (un fait) ;
//   · la source a échoué (une panne) ;
//   · la réponse n'est pas encore arrivée (on ne sait rien).
// Les confondre ferait passer une panne — ou un simple silence — pour une
// absence de risque.
describe('SCN-003 — absence de classe TRI : quatre vérités distinctes', () => {
  const base = {
    place: 'x',
    scenarioKey: 'extreme',
    onScenarioChange: vi.fn(),
    timeMin: 195,
    photo: null,
    hazardEvent: 'FLOODING',
  };

  /* Une réponse TRI « aucune classe au point », avec l'appartenance au
     périmètre renseignée — c'est `in_tri` qui départage. */
  const noClass = (inTri: boolean | null) =>
    ({
      available: false,
      reason: 'aucune classe au point',
      in_tri: inTri,
      resolution: 'per-building',
      scenarios: [],
      source: 'Géorisques WFS',
      source_url: null,
      retrieved_at: '2026-09-14T00:00:00+00:00',
    }) as unknown as FloodAleaResult;

  it('dans un TRI sans classe au point → le dit, sans conclure au hors-TRI', () => {
    render(<ScenarioPanel {...base} report={null} floodAlea={noClass(true)} />);
    expect(screen.getByText('Dans un TRI, sans classe au point')).toBeTruthy();
    expect(screen.queryByText(/Hors zone TRI/i)).toBeNull();
  });

  it('hors TRI → « Hors zone TRI », avec le garde-fou de sens', () => {
    render(<ScenarioPanel {...base} report={null} floodAlea={noClass(false)} />);
    expect(screen.getByText('Hors zone TRI')).toBeTruthy();
    expect(screen.getByText(/jamais inondé/i)).toBeTruthy();
  });

  it('appartenance non vérifiée → « Point non cartographié », sans trancher', () => {
    render(<ScenarioPanel {...base} report={null} floodAlea={noClass(null)} />);
    expect(screen.getByText(/Point non cartographié/i)).toBeTruthy();
    expect(screen.getByText(/n’a pas pu être vérifiée/i)).toBeTruthy();
  });

  it('service TRI injoignable → message de PANNE, pas d’absence de risque', () => {
    render(<ScenarioPanel {...base} report={null} floodAlea={null} triFailed />);
    expect(screen.getByText(/Service indisponible/i)).toBeTruthy();
    expect(screen.getByText(/n’a pas répondu|n'a pas répondu/)).toBeTruthy();
    expect(screen.queryByText(/Point non cartographié/i)).toBeNull();
  });

  it('réponse pas encore arrivée → aucun verdict affiché', () => {
    render(<ScenarioPanel {...base} report={null} floodAlea={null} triFailed={false} />);
    expect(screen.getByText(/Cartographie en cours/i)).toBeTruthy();
    expect(screen.queryByText(/Hors zone TRI/i)).toBeNull();
    expect(screen.queryByText(/Service indisponible/i)).toBeNull();
  });
});
