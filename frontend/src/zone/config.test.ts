import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * La résolution de `API` dépend de `window.location` au CHARGEMENT du module :
 * chaque cas recharge donc config.ts avec un faux hostname.
 */

async function apiForHostname(hostname: string): Promise<string> {
  const realLocation = window.location;
  vi.resetModules();
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { ...realLocation, hostname } as Location,
  });
  try {
    const { API } = await import('./config');
    return API;
  } finally {
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: realLocation,
    });
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('API — base des appels backend', () => {
  it('vise le backend FastAPI local en développement', async () => {
    expect(await apiForHostname('localhost')).toBe('http://127.0.0.1:8000');
    expect(await apiForHostname('127.0.0.1')).toBe('http://127.0.0.1:8000');
  });

  it('reste en MÊME ORIGINE sur un hôte déployé (URLs relatives /api, /diagnostic)', async () => {
    expect(await apiForHostname('typhoon-rose.vercel.app')).toBe('');
    expect(await apiForHostname('typhoon.example.com')).toBe('');
  });

  it('honore un override runtime explicite', async () => {
    (window as any).TYPHOON_API = 'https://api.exemple.test';
    try {
      expect(await apiForHostname('typhoon-rose.vercel.app')).toBe(
        'https://api.exemple.test',
      );
    } finally {
      delete (window as any).TYPHOON_API;
    }
  });

  it('ignore un override loopback sur un hôte déployé (sinon : « backend inaccessible ? »)', async () => {
    (window as any).TYPHOON_API = 'http://127.0.0.1:8000';
    try {
      expect(await apiForHostname('typhoon-rose.vercel.app')).toBe('');
      // …mais il reste respecté en développement local
      expect(await apiForHostname('localhost')).toBe('http://127.0.0.1:8000');
    } finally {
      delete (window as any).TYPHOON_API;
    }
  });

  // Note : VITE_API_BASE passe par le même garde-fou mais n'est pas testable
  // ici — Vite fige import.meta.env à la transformation, donc `vi.stubEnv`
  // (runtime) n'y apparaît pas. Vérifié au build : un chunk construit avec
  // VITE_API_BASE loopback n'expose plus l'URL loopback en production.
});
