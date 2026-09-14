// =============================================================================
//   TYPHOON — /zone : vol de caméra le long du trajet de l'eau.
//
//   Adaptation assumée de la recette de River Runner (Mapbox blog) à de la
//   géographie FRANÇAISE RÉELLE (BD TOPO, cf. hydroRoute.ts) :
//
//     · terrain 3D (`raster-dem`) exagéré + ciel/atmosphère : le relief donne
//       le sens de la descente vers l'exutoire ;
//     · un chemin LISSÉ pour la caméra, tandis que le tracé RÉEL reste dessiné
//       tel quel — c'est le point clé du blog : le spectateur suit la vraie
//       rivière, la caméra évite ses méandres ;
//     · vitesse de base liée à la longueur du parcours, élévation et lissage
//       recalculés quand la vitesse change (« peg » du zoom sur la vitesse) ;
//     · élévation maintenue par rapport au SOL via `queryTerrainElevation`,
//       pour ne pas décoller quand le lit descend vers la mer.
//
//   Ce module ne calcule AUCUNE donnée : il ne fait que déplacer la caméra et
//   publier une progression (distance parcourue / fraction) que l'appelant
//   traduit en marqueur et en tracé révélé (cf. hydroLayer.ts).
// =============================================================================

import mapboxgl from 'mapbox-gl';

import { cumulativeKm, sampleAt, type Journey, type LonLatZ } from './hydroRoute';

/* Type de la caméra libre, dérivé de l'API publique (le SDK n'exporte pas
   `FreeCameraOptions` dans ses types). */
type FreeCam = ReturnType<mapboxgl.Map['getFreeCameraOptions']>;

const DEM_SOURCE = 'typhoon-hydro-dem';
const TERRAIN_EXAGGERATION = 1.5;

/** Durée de lecture à 1× (secondes) — un parcours se lit, il ne défile pas. */
const BASE_DURATION_S = 40;
/** Pente de caméra du blog : assez basse pour lire le relief, pas de nausée. */
const PITCH = 70;
/** Élévation au sol : proportionnelle à la vitesse, bornée dans les deux sens. */
const ELEV_PER_KM_S = 2250;
const ELEV_MIN = 900;
const ELEV_MAX = 6000;

export type FlightRate = 1 | 4 | 16;

export interface FlightCallbacks {
  /** Progression (km parcourus, fraction 0..1). */
  onProgress?: (km: number, fraction: number) => void;
  onStateChange?: (playing: boolean, rate: FlightRate) => void;
  onEnd?: () => void;
}

/** Lissage du chemin de caméra (moyenne glissante, cf. blog). */
export function pathSmoother(coords: LonLatZ[], coefficient: number): LonLatZ[] {
  if (coords.length < 3 || coefficient <= 0) return coords;
  return coords.map((_, index) => {
    const from = Math.max(0, index - coefficient);
    const to = Math.min(coords.length, index + coefficient + 1);
    const group = coords.slice(from, to);
    let lon = 0;
    let lat = 0;
    let zSum = 0;
    let zCount = 0;
    for (const p of group) {
      lon += p[0];
      lat += p[1];
      if (p[2] != null) {
        zSum += p[2];
        zCount += 1;
      }
    }
    const z = zCount ? zSum / zCount : undefined;
    return (z != null ? [lon / group.length, lat / group.length, z] : [lon / group.length, lat / group.length]) as LonLatZ;
  });
}

export class WaterFlight {
  private raf = 0;
  private lastT = 0;
  private km = 0;
  private playing = false;
  private rate: FlightRate = 1;
  private smoothed: LonLatZ[];
  private smoothedCum: number[];
  private terrainTouched = false;
  private destroyed = false;

  constructor(
    private readonly map: mapboxgl.Map,
    private readonly journey: Journey,
    private readonly cb: FlightCallbacks = {}
  ) {
    this.smoothed = journey.coords;
    this.smoothedCum = journey.cum;
    this.rebuildSmoothing();
  }

  /* ── État ── */

  get totalKm(): number {
    return this.journey.totalKm;
  }

  get progressKm(): number {
    return this.km;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get currentRate(): FlightRate {
    return this.rate;
  }

  /* ── Terrain / ciel ── */

  /**
   * Active le relief 3D et l'atmosphère pour la durée du vol.
   *
   * Le style par défaut du produit est `mapbox://styles/mapbox/standard`, qui
   * gère déjà son atmosphère : on n'ajoute donc pas de couche « sky »
   * concurrente, on n'active que le terrain et on tente le brouillard
   * atmosphérique — sans jamais faire échouer le vol si le style refuse.
   */
  private enableTerrain(): void {
    const map = this.map;
    try {
      if (!map.getSource(DEM_SOURCE)) {
        map.addSource(DEM_SOURCE, {
          type: 'raster-dem',
          url: 'mapbox://mapbox-terrain-dem-v1',
          tileSize: 512,
          maxzoom: 14,
        });
      }
      map.setTerrain({ source: DEM_SOURCE, exaggeration: TERRAIN_EXAGGERATION });
      this.terrainTouched = true;
    } catch {
      this.terrainTouched = false;
    }
    try {
      const fogSet = typeof map.getFog === 'function' ? map.getFog() : null;
      if (typeof map.setFog === 'function' && !fogSet) {
        map.setFog({
          range: [0.8, 8],
          color: '#cfe6f5',
          'horizon-blend': 0.12,
          'high-color': '#8fc4e8',
          'space-color': '#0b1d33',
          'star-intensity': 0,
        });
      }
    } catch {
      /* style qui n'accepte pas le brouillard : on vole quand même */
    }
  }

  private disableTerrain(): void {
    if (!this.terrainTouched) return;
    try {
      this.map.setTerrain(null);
    } catch {
      /* déjà démonté avec le style */
    }
    this.terrainTouched = false;
  }

  /* ── Vitesse / lissage ── */

  /** km/s à 1× : le parcours entier se lit en `BASE_DURATION_S`. */
  private baseSpeedKmS(): number {
    return Math.max(0.25, this.totalKm / BASE_DURATION_S);
  }

  private speedKmS(): number {
    return this.baseSpeedKmS() * this.rate;
  }

  /** Élévation au-dessus du sol : suit la vitesse, bornée (cf. blog). */
  private elevationM(): number {
    const e = this.speedKmS() * ELEV_PER_KM_S;
    return Math.max(ELEV_MIN, Math.min(ELEV_MAX, e));
  }

  /** Lissage plus fort à grande vitesse : moins de méandres, moins de nausée. */
  private rebuildSmoothing(): void {
    const coefficient = Math.max(1, Math.min(14, Math.round(this.rate / 2) + 1));
    this.smoothed = pathSmoother(this.journey.coords, coefficient);
    this.smoothedCum = cumulativeKm(this.smoothed);
  }

  /* ── Transport ── */

  play(): void {
    if (this.destroyed || this.playing) return;
    if (this.km >= this.totalKm) this.km = 0;
    this.enableTerrain();
    this.playing = true;
    this.lastT = 0;
    this.cb.onStateChange?.(true, this.rate);
    this.raf = requestAnimationFrame(this.frame);
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.cb.onStateChange?.(false, this.rate);
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  setRate(rate: FlightRate): void {
    this.rate = rate;
    this.rebuildSmoothing();
    // Le tracé change de géométrie lissée : on replace la caméra tout de suite.
    this.applyCamera();
    this.cb.onStateChange?.(this.playing, this.rate);
  }

  /** Déplace la lecture à une distance donnée (curseur). */
  seek(km: number): void {
    this.km = Math.max(0, Math.min(this.totalKm, km));
    if (!this.playing) this.enableTerrain();
    this.applyCamera();
    this.cb.onProgress?.(this.km, this.totalKm > 0 ? this.km / this.totalKm : 0);
  }

  private frame = (t: number): void => {
    if (!this.playing || this.destroyed) return;
    const dt = this.lastT ? Math.min(0.05, (t - this.lastT) / 1000) : 0;
    this.lastT = t;
    this.km = Math.min(this.totalKm, this.km + this.speedKmS() * dt);
    this.applyCamera();
    this.cb.onProgress?.(this.km, this.totalKm > 0 ? this.km / this.totalKm : 0);
    if (this.km >= this.totalKm) {
      this.playing = false;
      cancelAnimationFrame(this.raf);
      this.cb.onStateChange?.(false, this.rate);
      this.cb.onEnd?.();
      return;
    }
    this.raf = requestAnimationFrame(this.frame);
  };

  /**
   * Place la caméra derrière le point courant, à l'élévation choisie, et la
   * fait regarder ce point. L'élévation est mesurée PAR RAPPORT AU SOL réel
   * (`queryTerrainElevation`) pour garder un cadrage constant quand le lit
   * descend vers l'exubtoire.
   */
  private applyCamera(): void {
    const map = this.map;
    if (this.destroyed || !this.journey.coords.length) return;
    if (typeof map.getFreeCameraOptions !== 'function') return;

    const target = sampleAt(this.smoothed, this.smoothedCum, this.km, null);
    if (!target) return;

    const elevation = this.elevationM();
    const backoff = elevation / Math.tan((PITCH * Math.PI) / 180);
    const bearingRad = (target.bearing * Math.PI) / 180;
    const latRad = (target.lat * Math.PI) / 180;

    // Recul le long du cap, en mètres → degrés.
    const camLat = target.lat - (Math.cos(bearingRad) * backoff) / 110540;
    const camLon = target.lon - (Math.sin(bearingRad) * backoff) / (111320 * Math.cos(latRad));

    let groundZ = 0;
    try {
      groundZ = map.queryTerrainElevation([camLon, camLat]) ?? 0;
    } catch {
      groundZ = 0;
    }
    // Repli sur l'altitude BD TOPO réelle du lit si le terrain n'est pas encore
    // disponible : la caméra reste cohérente avec le profil en long.
    const camAlt = (groundZ || target.z || 0) + elevation;

    try {
      const camera = map.getFreeCameraOptions();
      camera.position = mapboxgl.MercatorCoordinate.fromLngLat({ lon: camLon, lat: camLat }, camAlt);
      // `lookAtPoint` veut un LngLatLike ; l'altitude visée est le 3ᵉ argument.
      camera.lookAtPoint([target.lon, target.lat], undefined, target.z ?? 0);
      map.setFreeCameraOptions(camera);
    } catch {
      /* caméra libre indisponible (style en cours de chargement) */
    }
  }

  /** Rend la main à la caméra gérée par le SDK et libère le relief. */
  restore(): void {
    this.pause();
    this.disableTerrain();
    try {
      // `setFreeCameraOptions(null)` rend la caméra au SDK ; le SDK n'expose
      // pas de méthode de réinitialisation dédiée, d'où le cast.
      this.map.setFreeCameraOptions(null as unknown as FreeCam);
    } catch {
      /* rien à restaurer */
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.restore();
  }
}
