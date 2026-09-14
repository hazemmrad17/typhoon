import { describe, expect, it } from 'vitest';
import { gustAt, gustBand, gustProfileFrom, GUST_DAMAGE_KMH } from './windSim';
import type { MeteoData } from './hydroRoute';

const meteo = (gusts: Array<number | null>): MeteoData =>
  ({
    lat: 48.85,
    lon: 2.35,
    rain_hourly: [],
    wind_gusts_hourly: gusts.map((v, i) => ({
      t: `2026-09-14T${String(i).padStart(2, '0')}:00`,
      v,
    })),
    wind_gust_peak_kmh: Math.max(...(gusts.filter((v): v is number => v != null).length ? gusts.filter((v): v is number => v != null) : [0])),
    sources: {},
  }) as MeteoData;

describe('gustProfileFrom', () => {
  it('renvoie null sans prévision de vent (rien inventé)', () => {
    expect(gustProfileFrom(null)).toBeNull();
    expect(gustProfileFrom({ lat: 0, lon: 0, rain_hourly: [], sources: {} } as MeteoData)).toBeNull();
  });

  it('construit le profil depuis les rafales RÉELLES et trouve le pic', () => {
    const p = gustProfileFrom(meteo([10, 20, 90, 40]));
    expect(p).not.toBeNull();
    expect(p!.gust).toEqual([10, 20, 90, 40]);
    expect(p!.peakKmh).toBe(90);
    expect(p!.peakIndex).toBe(2);
    expect(p!.hours[2]).toMatch(/^\d{2}h$/);
  });

  it('retourne null si toutes les valeurs sont nulles', () => {
    expect(gustProfileFrom(meteo([null, null]))).toBeNull();
  });
});

describe('gustAt', () => {
  it('lit la rafale à l’index donné, borné', () => {
    const p = gustProfileFrom(meteo([10, 20, 90, 40]))!;
    expect(gustAt(p, 2)).toBe(90);
    expect(gustAt(p, 99)).toBe(40);
    expect(gustAt(p, -5)).toBe(10);
    expect(gustAt(null, 2)).toBe(0);
  });
});

describe('gustBand', () => {
  it('classe selon les seuils documentés', () => {
    expect(gustBand(30).key).toBe('none');
    expect(gustBand(70).key).toBe('moderate');
    expect(gustBand(GUST_DAMAGE_KMH).key).toBe('high');
    expect(gustBand(160).key).toBe('severe');
  });
});
