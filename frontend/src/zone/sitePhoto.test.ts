// =============================================================================
//   TYPHOON — sitePhoto : garde-fous du trait d'eau et de la provenance.
//
//   Le trait d'eau d'une vignette est un RAPPORT (hauteur d'eau modélisée /
//   hauteur de bâti BDNB). Ces tests verrouillent les cas où il ne doit PAS
//   être dessiné : c'est ce qui distingue un repère d'un motif décoratif.
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  photoCaption,
  photoCredit,
  photoDate,
  photoDetail,
  waterLineLabel,
  waterLinePct,
  type SitePhoto,
} from './sitePhoto';

describe('waterLinePct — part de la hauteur de bâti atteinte par l’eau', () => {
  it('rapporte la hauteur d’eau à la hauteur du bâtiment', () => {
    expect(waterLinePct(1.1, 34)).toBe(3.2);
    expect(waterLinePct(3.4, 34)).toBe(10);
    expect(waterLinePct(17, 34)).toBe(50);
  });

  it('borne le trait à la hauteur du bâti (jamais au-delà de la vignette)', () => {
    expect(waterLinePct(40, 34)).toBe(100);
  });

  it('ne dessine rien sans hauteur de bâti connue', () => {
    expect(waterLinePct(1.1, null)).toBeNull();
    expect(waterLinePct(null, 34)).toBeNull();
  });

  it('ne dessine rien pour une valeur absurde', () => {
    expect(waterLinePct(0, 34)).toBeNull();
    expect(waterLinePct(1.1, 0)).toBeNull();
    expect(waterLinePct(Number.NaN, 34)).toBeNull();
  });

  it('nomme le rapport, jamais une cote absolue', () => {
    const label = waterLineLabel(1.1, 34, 3.2);
    expect(label).toContain('1.10 m');
    expect(label).toContain('3.2 %');
    expect(label).toContain('BDNB');
  });
});

describe('photoCredit — provenance affichée', () => {
  const base: SitePhoto = {
    available: true,
    reason: null,
    label: null,
    candidates: 24,
    id: 'e6599eff',
    distance_m: 21.6,
    facing_ok: true,
    facing_error_deg: 40.1,
    view_azimuth: 30,
    captured_at: '2024-06-25T13:57:12.155000+02:00',
    thumb_url: 'https://panoramax.ign.fr/api/pictures/e6599eff/thumb.jpg',
    sd_url: 'https://panoramax.ign.fr/api/pictures/e6599eff/sd.jpg',
    page_url: 'https://api.panoramax.xyz/#focus=pic&pic=e6599eff',
    producer: 'immergis',
    licence: 'etalab-2.0',
    source: 'Panoramax (IGN / DINUM) — photos terrain, licence etalab-2.0',
    retrieved_at: '2026-09-13T00:00:00+00:00',
  };

  it('assemble source, producteur, date et licence', () => {
    const credit = photoCredit(base);
    expect(credit).toContain('Panoramax');
    expect(credit).toContain('immergis');
    expect(credit).toContain('25/06/2024');
    expect(credit).toContain('etalab-2.0');
  });

  it('omet proprement ce qui manque au lieu d’afficher « null »', () => {
    const credit = photoCredit({ ...base, producer: null, captured_at: null, licence: null });
    expect(credit).toBe('Panoramax');
    expect(credit).not.toContain('null');
  });

  it('gère une date illisible', () => {
    expect(photoDate('pas-une-date')).toBeNull();
    expect(photoDate(null)).toBeNull();
  });
});

describe('photoCaption / photoDetail — ce que la vignette est', () => {
  const base: SitePhoto = {
    available: true,
    reason: null,
    label: null,
    candidates: 24,
    id: 'e6599eff',
    distance_m: 21.6,
    facing_ok: true,
    facing_error_deg: 40.1,
    view_azimuth: 30,
    captured_at: '2024-06-25T13:57:12.155000+02:00',
    thumb_url: 'https://panoramax.ign.fr/api/pictures/e6599eff/thumb.jpg',
    sd_url: 'https://panoramax.ign.fr/api/pictures/e6599eff/sd.jpg',
    page_url: 'https://api.panoramax.xyz/#focus=pic&pic=e6599eff',
    producer: 'immergis',
    licence: 'etalab-2.0',
    source: 'Panoramax (IGN / DINUM) — photos terrain, licence etalab-2.0',
    retrieved_at: '2026-09-13T00:00:00+00:00',
  };

  it('n’annonce l’orientation que si elle est vérifiée', () => {
    expect(photoCaption(base)).toContain('orientée sur le point');
    expect(photoCaption(base)).toContain('21.6 m');
    expect(photoCaption({ ...base, facing_ok: false })).toContain('la plus proche du point');
  });

  it('garde le chiffre de l’écart dans l’infobulle, pas dans la ligne', () => {
    expect(photoDetail({ ...base, facing_ok: false })).toContain('40°');
    expect(photoCaption({ ...base, facing_ok: false })).not.toContain('40');
  });

  it('dit explicitement quand l’orientation n’est pas renseignée', () => {
    expect(photoDetail({ ...base, view_azimuth: null, facing_error_deg: null })).toContain(
      'non renseignée'
    );
  });
});
