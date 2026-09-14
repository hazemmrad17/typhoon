// =============================================================================
//   SCN-021 — cône de FEU : de la vignette SVG à la géométrie de carte.
//
//   La carte devient la source de vérité visuelle du cône, mais elle ne
//   produit rien de plus que ce que la vignette affichait déjà : même entrée
//   réelle (rafale de pic + sa direction), mêmes hypothèses affichées (portée,
//   ouverture). Sans météo ou sans coordonnées, aucun polygone n'est produit.
// =============================================================================

import { describe, expect, it } from 'vitest';
import { fireConeFrom, fireConePolygon, FIRE_REACH_MAX_KM } from './hazardSim';
import type { MeteoData } from './hydroRoute';

const ORIGIN = { lon: 6.64, lat: 43.27 };

function meteoWith(gustPeak: number | undefined, dir: number | undefined): MeteoData {
  return {
    lat: 43.27,
    lon: 6.64,
    rain_hourly: [],
    rain_total_mm: 0,
    dry: true,
    wind_gust_peak_kmh: gustPeak,
    wind_gust_peak_dir_deg: dir,
    sources: {},
  } as unknown as MeteoData;
}

describe('SCN-021 — fireConePolygon', () => {
  it('produit un polygone fermé ancré au point diagnostiqué', () => {
    const cone = fireConePolygon(meteoWith(120, 310), ORIGIN);
    expect(cone).not.toBeNull();
    expect(cone!.geometry.type).toBe('Polygon');

    const ring = cone!.geometry.coordinates[0];
    /* apex + 2 sommets + retour à l'apex : un triangle fermé. */
    expect(ring).toHaveLength(4);
    expect(ring[0]).toEqual([ORIGIN.lon, ORIGIN.lat]);
    expect(ring[3]).toEqual(ring[0]);
  });

  it('oriente le cône DANS le sens du vent (provenance + 180°)', () => {
    /* Vent de 350° (de nord) → propagation vers le sud : la latitude baisse. */
    const cone = fireConePolygon(meteoWith(120, 350), ORIGIN)!;
    for (const [, lat] of cone.geometry.coordinates[0].slice(1, 3)) {
      expect(lat).toBeLessThan(ORIGIN.lat);
    }
    expect(cone.properties.fromDeg).toBe(350);
  });

  it('vent d’ouest (270°) → propagation vers l’est : la longitude monte', () => {
    const cone = fireConePolygon(meteoWith(120, 270), ORIGIN)!;
    for (const [lon] of cone.geometry.coordinates[0].slice(1, 3)) {
      expect(lon).toBeGreaterThan(ORIGIN.lon);
    }
  });

  it('la portée reste bornée par FIRE_REACH_MAX_KM (borne d’affichage)', () => {
    const calm = fireConePolygon(meteoWith(20, 0), ORIGIN)!;
    const storm = fireConePolygon(meteoWith(200, 0), ORIGIN)!;
    expect(calm.properties.reachKm).toBeGreaterThan(0);
    expect(storm.properties.reachKm).toBeLessThanOrEqual(FIRE_REACH_MAX_KM + 1e-9);
    expect(storm.properties.reachKm).toBeGreaterThan(calm.properties.reachKm);
  });

  it('un vent plus fort resserre l’ouverture (le feu s’aligne)', () => {
    const calm = fireConeFrom(meteoWith(30, 0))!;
    const storm = fireConeFrom(meteoWith(150, 0))!;
    expect(storm.spreadDeg).toBeLessThan(calm.spreadDeg);
  });

  it('sans météo ou sans coordonnées : aucun polygone (rien d’inventé)', () => {
    expect(fireConePolygon(null, ORIGIN)).toBeNull();
    expect(fireConePolygon(meteoWith(undefined, undefined), ORIGIN)).toBeNull();
    expect(fireConePolygon(meteoWith(0, 310), ORIGIN)).toBeNull();
    expect(fireConePolygon(meteoWith(120, 310), null)).toBeNull();
    expect(
      fireConePolygon(meteoWith(120, 310), { lon: Number.NaN, lat: 43 })
    ).toBeNull();
  });

  it('propriétés : la donnée pilotante est exposée pour la légende', () => {
    const cone = fireConePolygon(meteoWith(95, 45), ORIGIN)!;
    expect(cone.properties.gustPeakKmh).toBe(95);
    expect(cone.properties.fromDeg).toBe(45);
    expect(cone.properties.spreadDeg).toBeGreaterThan(0);
  });
});
