// =============================================================================
//   TYPHOON — UnifiedMap : carte unique Mapbox GL JS v3 (pas de fallback
//   MapLibre) utilisée par /zone (Cartographie & Analyse).
//   Fond de carte : Mapbox Standard seul, en 2D comme en 3D (éclairage
//   « dusk » + landmarks 3D). Le fond sombre CARTO hérité de MapLibre a été
//   retiré : Mapbox est l'unique moteur de fond de carte.
//   · Bâtiments 3D (BDNB, extrusion par hauteur réelle) + surlignage accent
//     de l'empreinte du bâtiment diagnostiqué (extrusion 3D et teinte 2D)
//   · Couches de risque BRGM (WMS) + WFS Géorisques, à plat (pas de volumes
//     3D) — visibilité pilotée par les toggles œil du panneau latéral
//     (step Cartographie uniquement)
//   · Parcelles cadastrales IGN (toggle, step Analyse uniquement)
//   · Popup de l'adresse avec les aléas présents (step Cartographie)
//   · Resize différé pour suivre la transition du panneau latéral
//   · (Pas de sélection au clic : on étudie uniquement le bâtiment de
//     l'adresse diagnostiquée — le surlignage suit le rapport.)
// =============================================================================

import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

import {
  API,
  type BatimentRisques,
  type BdnbBatiment,
  type D03Band,
  type RisqueReport,
  WMS_LAYER_MAP,
  WFS_LAYER_MAP,
  D03,
  ALEA_ICONS,
  bandForKey,
  escHtml,
} from '../zone/config';
import {
  bboxAround,
  cadastreTileUrl,
  fetchWfsLayer,
  geomToWgs84,
  polygonCenter,
  wmsTileUrl,
} from '../zone/mapHelpers';

// Token + style en variable d'environnement (jamais en dur dans le code).
const MAPBOX_TOKEN: string = (import.meta as any).env?.VITE_MAPBOX_TOKEN || '';
const MAPBOX_STYLE: string =
  (import.meta as any).env?.VITE_MAPBOX_STYLE || 'mapbox://styles/mapbox/standard';
if (MAPBOX_TOKEN) {
  mapboxgl.accessToken = MAPBOX_TOKEN;
}

/* Style Mapbox Standard (GL JS v3) : éclairage « dusk » (coucher de soleil,
 * lumières de la ville) + objets 3D (bâtiments, arbres, landmarks). La config
 * est ignorée par les styles classiques (ex. dark-v11) — sans effet si
 * VITE_MAPBOX_STYLE pointe ailleurs. */
const IS_STANDARD_STYLE = MAPBOX_STYLE.includes('/standard');
const STANDARD_CONFIG = {
  basemap: {
    lightPreset: 'dusk',
    show3dObjects: true,
    show3dLandmarks: true,
  },
};

/* ── IDs de couches ── */
const BUILDINGS_LAYER = 'mb-buildings-3d';
const BUILDINGS_SOURCE = 'mb-bdnb-buildings';
const BUILDINGS_OUTLINE_LAYER = 'mb-buildings-outline';
/* Surlignage 2D du bâtiment diagnostiqué : empreinte teintée accent +
 * contour accent (visible en vue 2D, où l'extrusion 3D est masquée). */
const BUILDINGS_2D_LAYER = 'mb-buildings-2d-highlight';
/* Étiquette flottante du bâtiment cible (P9) — id BDNB tronqué, zoom ≥ 15. */
const TARGET_LABEL_LAYER = 'mb-target-label';
/* Bâtiments 3D natifs Mapbox (source composite/building — tout le bâti OSM,
 * « vibe ville numérique »). Ajoutés sous la couche BDNB. */
const NATIVE_BUILDINGS_LAYER = 'mb-native-buildings';

/* Parcelles cadastrales IGN (WMS data.geopf.fr) — toggle Analyse. */
const CADASTRE_LAYER = 'mb-cadastre';
const CADASTRE_SOURCE = 'mb-cadastre-src';

/** Accent courant (--accent sur .zone-app). */
function currentAccent(): string {
  let v = '';
  try {
    const app = document.querySelector('.zone-app');
    v =
      getComputedStyle(app ?? document.documentElement).getPropertyValue('--accent').trim() ||
      getComputedStyle(document.documentElement).getPropertyValue('--orange').trim();
  } catch { /* ignore */ }
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v : '#4C3F91';
}

/* Mode « Risques bâtiment » (P5/P8) : mappe les champs BDNB bruts vers un
 * score 0-100 puis une bande D03, avec exactement les mêmes seuils que le
 * backend (risk_model._argile_subscore / _radon_subscore / _sismique_subscore)
 * — la couleur sur la carte doit raconter la même histoire que le score du
 * diagnostic, pas une échelle inventée côté client. On ne dispose de ces
 * champs que pour le bâtiment cible (fiche BDNB dédiée) : seul lui est
 * recoloré par ce mode, pas ses voisins. */
const ARGILE_SCORE: Record<string, number> = { faible: 15, moyen: 50, fort: 82 };
const RADON_SCORE: Record<string, number> = { '1': 10, '2': 35, '3': 65 };
const SISMIQUE_SCORE: Record<string, number> = { '0': 5, '1': 15, '2': 30, '3': 50, '4': 70, '5': 88 };

function bandForBatimentScore(score: number): D03Band {
  return D03.find((b) => score <= b.max) || D03[D03.length - 1];
}

function batimentRiskBand(risques: BatimentRisques | null | undefined): D03Band | null {
  if (!risques) return null;
  const scores: number[] = [];
  const argile = risques.alea_argile?.toLowerCase().trim();
  if (argile && ARGILE_SCORE[argile] != null) scores.push(ARGILE_SCORE[argile]);
  const radon = risques.alea_radon != null ? String(risques.alea_radon).trim() : null;
  if (radon && RADON_SCORE[radon] != null) scores.push(RADON_SCORE[radon]);
  const sismique = risques.alea_sismique != null ? String(risques.alea_sismique).trim() : null;
  if (sismique && SISMIQUE_SCORE[sismique] != null) scores.push(SISMIQUE_SCORE[sismique]);
  if (!scores.length) return null;
  return bandForBatimentScore(Math.max(...scores));
}

/* ── Props ── */

/** Point du Portfolio (Ticket 4) : une adresse diagnostiquée en lot, avec
    sa bande D03 et son score — rendu en « mode points » (pas de rapport). */
export interface PortfolioPoint {
  lat: number;
  lon: number;
  label: string;
  /** Clé de bande D03 (tres_faible … critique) — colore le point. */
  band?: string | null;
  score?: number | null;
}

interface UnifiedMapProps {
  report: RisqueReport | null;
  visibleLayerKeys?: ReadonlySet<string>;
  /** Bâtiment de l'adresse diagnostiquée — surligné. */
  batiment?: BdnbBatiment | null;
  /** Niveaux de risque BDNB du bâtiment cible (argile/radon/sismique) — pilote
   *  le mode « Risques bâtiment » (P5/P8) : colore le bâtiment par D03 au lieu
   *  de la teinte accent neutre. Pas de fetch supplémentaire : réutilise la
   *  fiche déjà chargée pour le panneau latéral (Zone.tsx). */
  batimentRisques?: BatimentRisques | null;
  /** Afficher le popup aléas + couches WMS/WFS (étape Cartographie uniquement). */
  showRisks?: boolean;
  /** Afficher le toggle « Parcelles cadastrales » (étape Analyse uniquement). */
  allowParcels?: boolean;
  /** Défaut des parcelles cadastrales à l'arrivée sur l'étape (pilote depuis
   *  Zone.tsx : ON en « Bien & contexte », OFF dès qu'on la quitte). Le toggle
   *  manuel reste actif tant que l'étape ne change pas. */
  defaultParcels?: boolean;
  /** Défaut d'éclairage du style Standard à l'arrivée sur l'étape — « jour »
   *  (day) demandé pour « Bien & contexte » ; undefined = ne rien forcer. */
  defaultLightPreset?: 'day' | 'dusk';
  /** Nombre max de bâtiments chargés par bbox (0 = tous, jusqu'à épuisement).
   *  Cartographie : tous. Analyse : 200 (la carte y est secondaire). */
  buildingsLimit?: number;
  /** 3D au démarrage. */
  initial3D?: boolean;
  fitZoom?: number;
  /** Mode « points » (Portfolio) : une pastille par adresse colorée par
   *  bande D03. Quand fourni (non vide), remplace le rendu rapport. */
  points?: PortfolioPoint[];
}

/* ── Composant ── */

export function UnifiedMap({
  report,
  visibleLayerKeys = new Set<string>(),
  batiment,
  batimentRisques,
  showRisks = false,
  allowParcels = false,
  defaultParcels = false,
  defaultLightPreset,
  buildingsLimit = 200,
  initial3D = false,
  fitZoom = 16.5,
  points,
}: UnifiedMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const mapReadyRef = useRef(false);
  const buildingsSeqRef = useRef(0);
  const buildingsTimerRef = useRef<number | null>(null);
  const resizeTimerRef = useRef<number | null>(null);
  const renderSeqRef = useRef(0);
  const is3dRef = useRef(initial3D);
  const latestReportRef = useRef(report);
  latestReportRef.current = report;
  const pointsRef = useRef(points);
  pointsRef.current = points;
  const batimentRef = useRef(batiment);
  batimentRef.current = batiment;
  const batimentRisquesRef = useRef(batimentRisques);
  batimentRisquesRef.current = batimentRisques;
  const riskBuildingModeRef = useRef(false);
  const visibleKeysRef = useRef(visibleLayerKeys);
  visibleKeysRef.current = visibleLayerKeys;
  const buildingsLimitRef = useRef(buildingsLimit);
  buildingsLimitRef.current = buildingsLimit;
  /* Couches de risque WMS/WFS créées par `renderReport` : code d'aléa →
   * ids de couches (fill/outline/raster/circle), pour piloter leur
   * visibilité depuis les toggles œil du panneau latéral. */
  const layerIdsByKeyRef = useRef<Map<string, string[]>>(new Map());
  const markerRef = useRef<mapboxgl.Marker | null>(null);
  const popupRef = useRef<mapboxgl.Popup | null>(null);
  const pinElRef = useRef<HTMLDivElement | null>(null);
  /* Indicateur du bâtiment cible (épingle accrochée à la géométrie BDNB),
   * visible en 2D comme en 3D. */
  const buildingPinRef = useRef<mapboxgl.Marker | null>(null);

  const [is3d, setIs3d] = useState(initial3D);
  const [showParcels, setShowParcels] = useState(defaultParcels);
  const [riskBuildingMode, setRiskBuildingMode] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  /* Éclairage du style Standard : « crépuscule » (dusk) par défaut, forcé en
   * « jour » (day) sur l'étape « Bien & contexte » via `defaultLightPreset`
   * — toggle manuel via setConfigProperty. Le ref sert à la création de la
   * carte (le handler de load est une fermeture du premier rendu). */
  const [lightPreset, setLightPreset] = useState<'day' | 'dusk'>(defaultLightPreset ?? 'dusk');
  const lightPresetRef = useRef(lightPreset);
  lightPresetRef.current = lightPreset;
  const showParcelsRef = useRef(showParcels);
  showParcelsRef.current = showParcels;

  function currentBatiment(): BdnbBatiment | null {
    return batimentRef.current ?? latestReportRef.current?.bdnb?.batiment ?? null;
  }

  function highlightId(): string | null | undefined {
    return currentBatiment()?.batiment_groupe_id ?? null;
  }

  /** Couleur de remplissage du bâtiment cible : bande D03 (risque bâtiment) en
   *  mode « Risques bâtiment », sinon la teinte accent neutre habituelle. */
  function targetFillColor(): string {
    if (riskBuildingModeRef.current) {
      const band = batimentRiskBand(batimentRisquesRef.current);
      if (band) return band.color;
    }
    return currentAccent();
  }

  /* ── Init carte (une fois) ── */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!MAPBOX_TOKEN) {
      setMapError('Token Mapbox manquant — définissez VITE_MAPBOX_TOKEN dans le fichier .env à la racine du projet.');
      return;
    }

    /* Mode « points » (Portfolio) : le centre/zoom initial suit les points
       (fitBounds au load), pas le rapport — pas de rapport ici. */
    const pts = pointsRef.current;
    const rep = pts?.length ? null : latestReportRef.current;
    const center: [number, number] = rep ? [rep.lon, rep.lat] : [2.35, 46.8];

    const map = new mapboxgl.Map({
      container,
      style: MAPBOX_STYLE,
      config: {
        basemap: {
          ...STANDARD_CONFIG.basemap,
          lightPreset: lightPresetRef.current,
        },
      },
      center,
      zoom: rep ? fitZoom : 5,
      pitch: is3dRef.current ? 55 : 0,
      bearing: is3dRef.current ? -20 : 0,
      antialias: true,
      minZoom: 3,
      maxZoom: 19,
      attributionControl: true,
    });
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'bottom-right');
    mapRef.current = map;

    map.on('error', (e) => {
      // Erreurs de tuiles/sources (WMS BRGM, cadastre…) : non bloquantes.
      // (les champs sourceId/tile/data ne sont typés que sur les anciennes
      // versions — MapboxError de v2 — d'où le cast).
      const legacy = e as unknown as { sourceId?: string; tile?: unknown; data?: unknown; message?: string };
      if (legacy?.sourceId || legacy?.tile || legacy?.data) {
        console.warn('[mapbox] tuile/source:', e.error?.message ?? e);
        return;
      }
      const msg = String(e.error?.message ?? legacy?.message ?? '');
      // « The layer X does not exist in the map's style » : erreur transitoire
      // (race pendant un remount / swap de style) — jamais fatale, sinon le
      // bandeau d'erreur démonte une carte parfaitement fonctionnelle.
      if (/does not exist in the map's style/.test(msg)) {
        console.warn('[mapbox] couche transitoire:', msg);
        return;
      }
      // Seul un échec de chargement du style lui-même est fatal.
      if (/failed to (fetch|load) style|style is not done loading|stylesheet.*(404|error)|networkerror/i.test(msg)) {
        console.warn('[mapbox] erreur:', msg);
        setMapError((prev) => prev ?? 'Chargement du style Mapbox impossible');
        return;
      }
      console.warn('[mapbox] non bloquant:', msg);
    });

    map.on('load', () => {
      mapReadyRef.current = true;
      // Si le style a fini par se charger (retry HMR/dev), on lève le bandeau.
      setMapError(null);
      const pts = pointsRef.current;
      if (pts?.length) {
        renderPortfolioPoints(map, pts);
        return;
      }
      ensureCadastreLayer(map);
      ensureNativeBuildings(map);
      ensureBuildingsLayer(map);
      updateBuildingsTarget(map);
      placeBuildingPin(map);
      void loadBuildings(map);
      if (showRisks) renderReport(map, latestReportRef.current);
    });

    map.on('moveend', () => {
      if (!is3dRef.current) return;
      if (buildingsTimerRef.current) window.clearTimeout(buildingsTimerRef.current);
      buildingsTimerRef.current = window.setTimeout(() => void loadBuildings(map), 500);
    });

    /* Resize différé (panneau latéral) */
    let firstPaint = true;
    const ro = new ResizeObserver(() => {
      const el = containerRef.current;
      if (!el) return;
      if (el.clientWidth === 0 || el.clientHeight === 0) return;
      if (resizeTimerRef.current) window.clearTimeout(resizeTimerRef.current);
      const first = firstPaint;
      firstPaint = false;
      resizeTimerRef.current = window.setTimeout(() => {
        resizeTimerRef.current = null;
        const m = mapRef.current;
        if (!m) return;
        m.resize();
        if (first) void loadBuildings(m);
      }, first ? 60 : 350);
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      if (resizeTimerRef.current) window.clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = null;
      if (buildingsTimerRef.current) window.clearTimeout(buildingsTimerRef.current);
      buildingsTimerRef.current = null;
      mapReadyRef.current = false;
      mapRef.current = null;
      markerRef.current?.remove();
      markerRef.current = null;
      popupRef.current?.remove();
      popupRef.current = null;
      pinElRef.current?.remove();
      pinElRef.current = null;
      buildingPinRef.current?.remove();
      buildingPinRef.current = null;
      map.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Changement de bâtiment/adresse ── */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current) return;
    updateBuildingsTarget(map);
    placeBuildingPin(map);
    const b = currentBatiment();
    if (b?.geom_groupe) {
      try {
        const wgs = geomToWgs84(b.geom_groupe as Record<string, unknown>);
        const c = polygonCenter(wgs?.coordinates);
        if (c) map.easeTo({ center: c, zoom: fitZoom, pitch: is3dRef.current ? 55 : 0, duration: 900 });
      } catch { /* */ }
    }
    if (is3dRef.current) void loadBuildings(map);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batiment, batimentRisques, report]);

  /* ── Mode points (Portfolio) : re-rendu quand la liste change ── */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current) return;
    if (points?.length) {
      renderPortfolioPoints(map, points);
    }
  }, [points]);

  /* ── Gros plan (step Cartographie : marqueur + popup + calques aléas) ── */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current) return;
    if (showRisks) {
      renderReport(map, report);
    } else {
      // Quitter Cartographie sans ça laissait les couches de zone posées
      // sur la carte : `renderReport` ne se relance pas ici, donc rien ne
      // les cachait — elles restaient visibles une fois passé en Analyse.
      hideLayersModeLayers(map);
      popupRef.current?.remove();
      popupRef.current = null;
      if (report) placeMarker(map, report);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showRisks, report]);

  /* ── visibleLayerKeys → masquer/afficher les couches WMS/WFS ──
     Ne s'applique que quand showRisks est vrai (étape Cartographie/Synthèse).
     En Analyse (allowParcels), on ne veut jamais de couches de risque —
     seulement les parcelles cadastrales. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current) return;
    if (showRisks) {
      applyRiskLayersVisibility(map);
    } else {
      // Étape sans couches de risque (Analyse) : tout masquer.
      hideLayersModeLayers(map);
    }
  }, [visibleLayerKeys, showRisks]);

  /* ── Défauts d'étape (pilotés par Zone.tsx) : parcelles + éclairage ──
     Chaque changement d'étape change la prop et ré-applique son défaut ; le
     toggle manuel reste ensuite le maître jusqu'à la prochaine étape. */
  useEffect(() => {
    setShowParcels(defaultParcels);
    showParcelsRef.current = defaultParcels;
    const map = mapRef.current;
    if (!map || !mapReadyRef.current || !map.getLayer(CADASTRE_LAYER)) return;
    map.setLayoutProperty(CADASTRE_LAYER, 'visibility', defaultParcels ? 'visible' : 'none');
  }, [defaultParcels]);

  useEffect(() => {
    if (defaultLightPreset == null) return;
    setLightPreset(defaultLightPreset);
    lightPresetRef.current = defaultLightPreset;
    const map = mapRef.current;
    if (!map || !mapReadyRef.current || !IS_STANDARD_STYLE) return;
    try {
      map.setConfigProperty('basemap', 'lightPreset', defaultLightPreset);
    } catch {
      // Style non-Standard : la config est ignorée, rien à faire.
    }
  }, [defaultLightPreset]);

  /** Applique la visibilité des couches de risque selon le toggle par aléa
   *  du panneau latéral (`visibleLayerKeys`). Restent visibles en 3D aussi
   *  (P6/P3 provisoire) : ce sont des aplats au sol sans extrusion propre, ce
   *  qui est moins lisible en caméra inclinée qu'un futur relief par bande
   *  D03, mais les masquer entièrement cachait de l'information réelle sans
   *  raison — mieux vaut un aplat plat visible qu'une couche invisible. */
  function applyRiskLayersVisibility(map: mapboxgl.Map) {
    for (const [key, ids] of layerIdsByKeyRef.current) {
      const visible = visibleKeysRef.current.has(key);
      for (const id of ids) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
      }
    }
  }

  /** Cache toutes les couches de risque (fills WMS/WFS de `renderReport`),
   *  indépendamment de `visibleLayerKeys` — utilisé en quittant Cartographie
   *  pour ne pas laisser les couches de la carte précédente visibles sur
   *  les étapes suivantes. */
  function hideLayersModeLayers(map: mapboxgl.Map) {
    for (const ids of layerIdsByKeyRef.current.values()) {
      for (const id of ids) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
      }
    }
  }

  /* ═══════════ Couches sources et rendu ═══════════ */

  /** Bâtiments 3D natifs Mapbox : tout le bâti OSM extrudé (hauteurs réelles
   *  OSM, approx.) — remplace le chargement BDNB par viewport pour l'effet
   *  « ville numérique » en vue 3D. Avec le style Standard (GL JS v3) la ville
   *  3D est déjà rendue nativement (avec landmarks) : la couche est superflue. */
  function ensureNativeBuildings(map: mapboxgl.Map) {
    if (IS_STANDARD_STYLE) return;
    if (map.getLayer(NATIVE_BUILDINGS_LAYER)) return;
    map.addLayer({
      id: NATIVE_BUILDINGS_LAYER,
      type: 'fill-extrusion',
      source: 'composite',
      'source-layer': 'building',
      minzoom: 14,
      layout: { visibility: is3dRef.current ? 'visible' : 'none' },
      paint: {
        'fill-extrusion-height': [
          'interpolate', ['linear'], ['zoom'],
          14, 0,
          15.2, ['coalesce', ['get', 'height'], 8],
        ],
        'fill-extrusion-base': [
          'interpolate', ['linear'], ['zoom'],
          14, 0,
          15.2, ['coalesce', ['get', 'min_height'], 0],
        ],
        'fill-extrusion-color': [
          'interpolate', ['linear'], ['coalesce', ['get', 'height'], 8],
          0, '#4a5568', 10, '#6b7c93', 25, '#93a7bf', 45, '#c3d2e2',
        ],
        'fill-extrusion-opacity': 0.9,
        'fill-extrusion-vertical-gradient': true,
      },
    });
  }

  /** Parcelles cadastrales IGN (WMS data.geopf.fr) — toggle Analyse. */
  function ensureCadastreLayer(map: mapboxgl.Map) {
    if (map.getLayer(CADASTRE_LAYER)) return;
    map.addSource(CADASTRE_SOURCE, {
      type: 'raster',
      tiles: [cadastreTileUrl()],
      tileSize: 256,
      maxzoom: 19,
      attribution: 'Parcelles © IGN',
    });
    map.addLayer({
      id: CADASTRE_LAYER,
      type: 'raster',
      source: CADASTRE_SOURCE,
      /* Visibilité initiale selon le défaut d'étape (le handler de load est
         une fermeture du premier rendu — on lit donc le ref, pas l'état). */
      layout: { visibility: showParcelsRef.current ? 'visible' : 'none' },
      paint: { 'raster-opacity': 1 },
    });
  }

  function ensureBuildingsLayer(map: mapboxgl.Map) {
    if (map.getLayer(BUILDINGS_LAYER)) return;
    map.addSource(BUILDINGS_SOURCE, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    map.addLayer({
      id: BUILDINGS_LAYER,
      type: 'fill-extrusion',
      source: BUILDINGS_SOURCE,
      layout: { visibility: is3dRef.current ? 'visible' : 'none' },
      paint: {
        'fill-extrusion-height': ['case', ['>', ['coalesce', ['get', 'hauteur_mean'], 0], 0], ['get', 'hauteur_mean'], 9],
        'fill-extrusion-base': 0,
        'fill-extrusion-color': buildingColorExpr(highlightId(), targetFillColor()),
        'fill-extrusion-opacity': 0.95,
        'fill-extrusion-vertical-gradient': true,
      },
    });
    const targetId = highlightId() ?? null;
    map.addLayer({
      id: BUILDINGS_OUTLINE_LAYER,
      type: 'line',
      source: BUILDINGS_SOURCE,
      filter: targetId ? ['==', ['get', 'batiment_groupe_id'], targetId] : ['==', ['get', 'batiment_groupe_id'], ''],
      layout: { visibility: is3dRef.current ? 'visible' : 'none' },
      paint: { 'line-color': currentAccent(), 'line-width': 2.5, 'line-opacity': 0.95 },
    });
    /* Surlignage 2D : visible uniquement en vue 2D (l'extrusion fait le
       travail en 3D). L'empreinte du bâtiment cible est teintée accent. */
    map.addLayer({
      id: BUILDINGS_2D_LAYER,
      type: 'fill',
      source: BUILDINGS_SOURCE,
      filter: targetId ? ['==', ['get', 'batiment_groupe_id'], targetId] : ['==', ['get', 'batiment_groupe_id'], ''],
      layout: { visibility: is3dRef.current ? 'none' : 'visible' },
      paint: {
        'fill-color': targetFillColor(),
        'fill-opacity': 0.4,
        'fill-outline-color': currentAccent(),
      },
    });
    /* Étiquette flottante du bâtiment cible (P9) — id BDNB tronqué, visible
       à partir du zoom 15 (identification même sous des volumes de risque). */
    map.addLayer({
      id: TARGET_LABEL_LAYER,
      type: 'symbol',
      source: BUILDINGS_SOURCE,
      filter: targetId ? ['==', ['get', 'batiment_groupe_id'], targetId] : ['==', ['get', 'batiment_groupe_id'], ''],
      minzoom: 15,
      layout: {
        'text-field': ['slice', ['get', 'batiment_groupe_id'], -9],
        'text-size': 11,
        'text-anchor': 'bottom',
        'text-offset': [0, -1.2],
        'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
        'symbol-placement': 'point',
      },
      paint: {
        'text-color': currentAccent(),
        'text-halo-color': 'rgba(10,14,20,0.85)',
        'text-halo-width': 1.2,
      },
    });
  }

  function updateBuildingsTarget(map: mapboxgl.Map) {
    const targetId = highlightId() ?? null;
    const accent = currentAccent();
    const fillColor = targetFillColor();
    const filterExpr: any = targetId ? ['==', ['get', 'batiment_groupe_id'], targetId] : ['==', ['get', 'batiment_groupe_id'], ''];
    if (map.getLayer(BUILDINGS_LAYER)) {
      map.setPaintProperty(BUILDINGS_LAYER, 'fill-extrusion-color', buildingColorExpr(targetId, fillColor));
      // En 3D, la ville est rendue par les bâtiments natifs Mapbox : la couche
      // BDNB ne garde que le bâtiment cible (surligné) pour éviter la double
      // extrusion sur les mêmes empreintes.
      map.setFilter(BUILDINGS_LAYER, filterExpr);
    }
    if (map.getLayer(BUILDINGS_OUTLINE_LAYER)) {
      map.setFilter(BUILDINGS_OUTLINE_LAYER, filterExpr);
      // Le contour reste accent (pas la bande de risque) : le bâtiment cible
      // doit rester identifiable même quand son remplissage change de couleur
      // selon le péril affiché (cf. principe P9 « le bâtiment reste le héros »).
      map.setPaintProperty(BUILDINGS_OUTLINE_LAYER, 'line-color', accent);
    }
    if (map.getLayer(BUILDINGS_2D_LAYER)) {
      map.setFilter(BUILDINGS_2D_LAYER, filterExpr);
      map.setPaintProperty(BUILDINGS_2D_LAYER, 'fill-color', fillColor);
      map.setPaintProperty(BUILDINGS_2D_LAYER, 'fill-outline-color', accent);
    }
    if (map.getLayer(TARGET_LABEL_LAYER)) {
      map.setFilter(TARGET_LABEL_LAYER, filterExpr);
      map.setPaintProperty(TARGET_LABEL_LAYER, 'text-color', accent);
    }
  }

  /* ── Rendu Cartographie : marqueur + popup + calques aléas WMS/WFS ── */

  function renderReport(map: mapboxgl.Map, rep: RisqueReport | null) {
    /* Nettoyage des couches de risque précédentes — toutes les couches
     * d'abord (fill + outline peuvent partager une même source), puis les
     * sources : `removeSource` échoue tant qu'une couche la référence. */
    for (const ids of layerIdsByKeyRef.current.values()) {
      for (const id of ids) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
    }
    for (const ids of layerIdsByKeyRef.current.values()) {
      for (const id of ids) {
        if (map.getSource(`src-${id}`)) map.removeSource(`src-${id}`);
      }
    }
    layerIdsByKeyRef.current.clear();
    const seq = ++renderSeqRef.current;

    placeMarker(map, rep);
    popupRef.current?.remove();
    popupRef.current = null;

    if (!rep) return;

    const aleaRows = (rep.aleas || [])
      .filter((a) => a.present === true && a.niveau)
      .map((a) => {
        const band = bandForKey(a.niveau);
        const color = band?.color ?? '#8A8984';
        const label = band?.label ?? a.niveau ?? '';
        const icon = ALEA_ICONS[a.code] ?? 'crisis_alert';
        return (
          `<div class="mb-risk-row">` +
          `<md-icon aria-hidden="true">${icon}</md-icon>` +
          `<span class="mb-risk-name">${escHtml(a.libelle)}</span>` +
          `<span class="mb-risk-pill" style="--risk-color:${color}">${escHtml(label)}</span>` +
          `</div>`
        );
      })
      .join('');

    /* Indicateur d'adresse compact : en-tête adresse + aléas présents en
       pastilles de niveau colorées (pas de gros popup ni de liens externes —
       la carte et le panneau latéral restent les interactions principales). */
    popupRef.current = new mapboxgl.Popup({ offset: 22, closeButton: true, maxWidth: '300px', className: 'mb-risk-popup' })
      .setLngLat([rep.lon, rep.lat])
      .setHTML(
        `<div class="mb-risk-head">` +
        `<md-icon aria-hidden="true">pin_drop</md-icon>` +
        `<span class="mb-risk-addr">${escHtml(rep.adresse_normalisee)}</span>` +
        `</div>` +
        `<div class="mb-risk-rows">` +
        (aleaRows ||
          `<div class="mb-risk-row"><span class="mb-risk-name">Aucun aléa présent</span><span class="mb-risk-pill">—</span></div>`) +
        `</div>`
      )
      .addTo(map);

    map.easeTo({ center: [rep.lon, rep.lat], zoom: fitZoom, duration: 1200 });

    /* Surbrillance du bâtiment diagnostiqué */
    updateBuildingsTarget(map);

    /* Couches WMS + WFS, à plat (pas de volumes 3D). Le vecteur (WFS) prime
     * sur le raster (WMS) dès que la donnée existe pour l'aléa : plusieurs
     * FeatureType peuvent composer un même aléa (ex. ppr agrège 8 couches
     * de périmètres) — on les fusionne en une seule source. Le raster reste
     * le repli si le vecteur ne renvoie aucune feature dans la bbox. */
    const bbox = bboxAround(rep.lon, rep.lat);
    const renderLayers = async () => {
      for (const a of rep.aleas || []) {
        if (seq !== renderSeqRef.current) return;
        /* Aléas à source indisponible (present=null) : aucune donnée à
           afficher. Les aléas ABSENTS (present=false) restent affichables :
           leurs couches WMS/WFS montrent la donnée communale — l'utilisateur
           peut visualiser le risque même s'il n'est pas présent à l'adresse. */
        if (a.present === null) continue;
        const band = a.niveau ? bandForKey(a.niveau) : undefined;
        const color = band?.color || '#7A9187';
        // Aplats au sol, pas d'extrusion — restent visibles en 3D (cf.
        // applyRiskLayersVisibility) même si moins lisibles en caméra inclinée
        // qu'un futur relief par bande D03 (P6).
        const visible = visibleKeysRef.current.has(a.code);
        const layerId = `alea-${a.code}`;
        const sourceId = `src-${layerId}`;
        const track = (id: string) => {
          if (!layerIdsByKeyRef.current.has(a.code)) layerIdsByKeyRef.current.set(a.code, []);
          layerIdsByKeyRef.current.get(a.code)!.push(id);
        };

        let wfsRendered = false;
        if (WFS_LAYER_MAP[a.code]) {
          const merged: GeoJSON.Feature[] = [];
          for (const typeName of WFS_LAYER_MAP[a.code]) {
            try {
              const geojson = await fetchWfsLayer(typeName, bbox);
              if (seq !== renderSeqRef.current) return;
              if (geojson?.features?.length) merged.push(...geojson.features);
            } catch { /* couche suivante */ }
          }
          if (merged.length) {
            const data = {
              type: 'FeatureCollection' as const,
              features: merged.map((f) => ({ ...f, properties: { ...(f.properties || {}), niveau: a.niveau } })),
            };
            map.addSource(sourceId, { type: 'geojson', data });
            const outlineId = `${layerId}-outline`;
            if (a.code === 'ppr') {
              /* Périmètres PPR : CONTOUR RÉGLEMENTAIRE uniquement, pas d'aplat.
                 Un périmètre PPR couvre toute la zone du plan ; le remplir avec
                 la bande D03 de l'adresse produisait des aplats orange trompeurs
                 sur des zones entières. En tiretés, il se lit comme une
                 délimitation (comme sur le portail Géorisques), pas comme une
                 intensité homogène. */
              map.addLayer({
                id: outlineId, type: 'line', source: sourceId,
                layout: { visibility: visible ? 'visible' : 'none' },
                paint: {
                  'line-color': color,
                  'line-width': a.niveau === 'critique' ? 2.5 : 1.8,
                  'line-opacity': 0.9,
                  'line-dasharray': [4, 3],
                },
              });
              track(outlineId);
            } else {
              map.addLayer({
                id: layerId, type: 'fill', source: sourceId,
                layout: { visibility: visible ? 'visible' : 'none' },
                paint: {
                  'fill-color': color,
                  'fill-opacity': 0.5,
                  'fill-outline-color': '#263238',
                },
              });
              map.addLayer({
                id: outlineId, type: 'line', source: sourceId,
                layout: { visibility: visible ? 'visible' : 'none' },
                paint: {
                  'line-color': color,
                  'line-width': a.niveau === 'critique' ? 3 : a.niveau === 'eleve' ? 2 : 1.2,
                  'line-opacity': 0.6,
                },
              });
              track(layerId);
              track(outlineId);
            }
            wfsRendered = true;
          }
        }
        if (wfsRendered) continue;

        if (WMS_LAYER_MAP[a.code]) {
          map.addSource(sourceId, { type: 'raster', tiles: [wmsTileUrl(WMS_LAYER_MAP[a.code])], tileSize: 256, maxzoom: 19 });
          map.addLayer({ id: layerId, type: 'raster', source: sourceId, layout: { visibility: visible ? 'visible' : 'none' }, paint: { 'raster-opacity': 0.65 } });
          track(layerId);
          continue;
        }

        /* Fallback : cercle ponctuel — marque une présence communale, pas la
         * zone exacte du risque. Réservé aux aléas PRÉSENTS : pour un aléa
         * absent sans couche WMS/WFS il n'y a aucune donnée à montrer. */
        if (a.present !== true) continue;
        map.addSource(sourceId, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [rep.lon, rep.lat] }, properties: {} }] },
        });
        const circle: any = { 'circle-radius': 10, 'circle-color': color, 'circle-opacity': 0.65 };
        if (a.niveau && D03.find((d) => d.key === a.niveau)) {
          circle['circle-stroke-color'] = color;
          circle['circle-stroke-width'] = a.niveau === 'critique' ? 3 : 1;
        }
        map.addLayer({ id: layerId, type: 'circle', source: sourceId, layout: { visibility: visible ? 'visible' : 'none' }, paint: circle });
        track(layerId);
      }
    };
    void renderLayers();
  }

  /* ── Rendu Portfolio (mode « points », Ticket 4) : une pastille par
     adresse colorée par bande D03, popup au clic, fitBounds global. ── */

  const PORTFOLIO_LAYER = 'mb-portfolio-points';
  const PORTFOLIO_OUTLINE = 'mb-portfolio-outline';
  const PORTFOLIO_SOURCE = 'mb-portfolio-src';
  const PORTFOLIO_LABELS = 'mb-portfolio-labels';

  function renderPortfolioPoints(map: mapboxgl.Map, pts: PortfolioPoint[]) {
    for (const id of [PORTFOLIO_LAYER, PORTFOLIO_OUTLINE, PORTFOLIO_LABELS]) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    if (map.getSource(PORTFOLIO_SOURCE)) map.removeSource(PORTFOLIO_SOURCE);

    if (!pts.length) return;

    const features: GeoJSON.Feature[] = pts
      .filter((p) => isFinite(p.lat) && isFinite(p.lon))
      .map((p) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] },
        properties: {
          label: p.label,
          band: p.band ?? null,
          score: p.score ?? null,
        },
      }));

    map.addSource(PORTFOLIO_SOURCE, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features },
    });

    /* Couleur par bande D03 — fallback ardoise pour « pas de bande ». */
    const colorExpr: any = [
      'match',
      ['get', 'band'],
      ...D03.flatMap((b) => [b.key, b.color]),
      '#64748b',
    ];

    map.addLayer({
      id: PORTFOLIO_LAYER,
      type: 'circle',
      source: PORTFOLIO_SOURCE,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 5, 8, 9, 12, 13],
        'circle-color': colorExpr,
        'circle-opacity': 0.85,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.2,
      },
    });
    map.addLayer({
      id: PORTFOLIO_OUTLINE,
      type: 'circle',
      source: PORTFOLIO_SOURCE,
      filter: ['==', ['get', 'band'], 'critique'],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 7, 8, 11, 12, 15],
        'circle-color': 'transparent',
        'circle-stroke-color': '#B03020',
        'circle-stroke-width': 2,
      },
    });
    map.addLayer({
      id: PORTFOLIO_LABELS,
      type: 'symbol',
      source: PORTFOLIO_SOURCE,
      minzoom: 10,
      layout: {
        'text-field': ['get', 'label'],
        'text-size': 10.5,
        'text-anchor': 'top',
        'text-offset': [0, 1.1],
        'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
        'text-max-width': 10,
      },
      paint: {
        'text-color': '#111827',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.4,
      },
    });

    /* Popup au clic : adresse + bande + score. */
    map.on('click', PORTFOLIO_LAYER, (e) => {
      popupRef.current?.remove();
      popupRef.current = null;
      const f = e.features?.[0];
      if (!f?.geometry || f.geometry.type !== 'Point') return;
      const props = f.properties || {};
      const band = D03.find((b) => b.key === props.band);
      popupRef.current = new mapboxgl.Popup({ offset: 18, closeButton: true, maxWidth: '260px' })
        .setLngLat((f.geometry as GeoJSON.Point).coordinates as [number, number])
        .setHTML(
          `<div class="mb-risk-head"><md-icon aria-hidden="true">location_on</md-icon>` +
          `<span class="mb-risk-addr">${escHtml(props.label)}</span></div>` +
          `<div class="mb-risk-rows">` +
          `<div class="mb-risk-row"><span class="mb-risk-name">Bande D03</span>` +
          `<span class="mb-risk-pill" style="--risk-color:${band?.color ?? '#64748b'}">${escHtml(band?.label ?? '—')}</span></div>` +
          (props.score != null
            ? `<div class="mb-risk-row"><span class="mb-risk-name">Score</span>` +
              `<span class="mb-risk-pill">${props.score}/100</span></div>`
            : '') +
          `</div>`
        )
        .addTo(map);
    });
    map.on('mouseenter', PORTFOLIO_LAYER, () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', PORTFOLIO_LAYER, () => {
      map.getCanvas().style.cursor = '';
    });

    /* Cadrage global sur les points. */
    const bounds = new mapboxgl.LngLatBounds();
    pts.forEach((p) => {
      if (isFinite(p.lat) && isFinite(p.lon)) bounds.extend([p.lon, p.lat]);
    });
    if (!bounds.isEmpty()) {
      map.fitBounds(bounds, { padding: 60, maxZoom: 13, duration: 900 });
    }
  }

  /* ── Marqueur ── */

  function placeMarker(map: mapboxgl.Map, rep: RisqueReport | null) {
    markerRef.current?.remove();
    markerRef.current = null;
    if (!rep) return;
    const el = document.createElement('div');
    el.className = 'map-pin';
    el.innerHTML = '<span class="map-pin-dot"></span><span class="map-pin-stem"></span>';
    markerRef.current = new mapboxgl.Marker({ element: el, anchor: 'bottom', offset: [0, 0] })
      .setLngLat([rep.lon, rep.lat])
      .addTo(map);
  }

  /** Épingle « bâtiment cible » : accrochée au centre de l'empreinte BDNB
   *  (géométrie réelle), visible en 2D comme en 3D. Le surlignage accent
   *  de la couche BDNB fait le reste en 3D. */
  function placeBuildingPin(map: mapboxgl.Map) {
    buildingPinRef.current?.remove();
    buildingPinRef.current = null;
    const b = currentBatiment();
    if (!b?.geom_groupe) return;
    try {
      const wgs = geomToWgs84(b.geom_groupe as Record<string, unknown>);
      const c = polygonCenter(wgs?.coordinates);
      if (!c) return;
      const el = document.createElement('div');
      el.className = 'bldg-pin';
      el.innerHTML = '<span class="bldg-pin-dot"></span>';
      buildingPinRef.current = new mapboxgl.Marker({ element: el, anchor: 'bottom', offset: [0, 0] })
        .setLngLat([c[0], c[1]])
        .addTo(map);
    } catch { /* */ }
  }

  async function loadBuildings(map: mapboxgl.Map) {
    let west = 0, south = 0, east = 0, north = 0;
    try {
      const bounds = map.getBounds();
      if (!bounds) return; // type v3 : LngLatBounds | null
      west = bounds.getWest(); south = bounds.getSouth(); east = bounds.getEast(); north = bounds.getNorth();
      if (!isFinite(west) || !isFinite(east)) return;
    } catch { return; }
    const seq = ++buildingsSeqRef.current;
    const url = `${API}/diagnostic/zone/buildings?west=${west}&south=${south}&east=${east}&north=${north}&limit=${buildingsLimitRef.current}`;
    try {
      const resp = await fetch(url);
      if (seq !== buildingsSeqRef.current || !mapRef.current) return;
      if (!resp.ok) return;
      const fc = (await resp.json()) as GeoJSON.FeatureCollection;
      if (seq !== buildingsSeqRef.current) return;
      ensureBuildingsLayer(map);
      const b = currentBatiment();
      const targetId = b?.batiment_groupe_id;
      if (targetId) {
        const targetInFc = fc.features.some((f) => f.properties?.batiment_groupe_id === targetId);
        if (b && !targetInFc && b.geom_groupe) {
          const wgsGeom = geomToWgs84(b.geom_groupe as Record<string, unknown>);
          if (wgsGeom) fc.features.push({ type: 'Feature', geometry: wgsGeom as unknown as GeoJSON.Geometry, properties: { batiment_groupe_id: b.batiment_groupe_id, hauteur_mean: b.hauteur_mean || 10 } });
        }
      }
      (map.getSource(BUILDINGS_SOURCE) as mapboxgl.GeoJSONSource)?.setData(fc);
    } catch { /* */ }
  }

  function toggle3D(enabled: boolean) {
    const map = mapRef.current;
    if (!map) return;
    is3dRef.current = enabled; setIs3d(enabled);
    for (const id of [BUILDINGS_LAYER, BUILDINGS_OUTLINE_LAYER, NATIVE_BUILDINGS_LAYER]) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', enabled ? 'visible' : 'none');
    }
    if (map.getLayer(BUILDINGS_2D_LAYER)) {
      map.setLayoutProperty(BUILDINGS_2D_LAYER, 'visibility', enabled ? 'none' : 'visible');
    }
    if (enabled) updateBuildingsTarget(map); // filtre BDNB → bâtiment cible
    applyRiskLayersVisibility(map); // couches de risque : 2D uniquement
    map.easeTo({ pitch: enabled ? 55 : 0, duration: 800 });
    if (enabled) void loadBuildings(map);
  }

  function toggleParcels(enabled: boolean) {
    const map = mapRef.current;
    if (!map) return;
    setShowParcels(enabled);
    if (map.getLayer(CADASTRE_LAYER)) {
      map.setLayoutProperty(CADASTRE_LAYER, 'visibility', enabled ? 'visible' : 'none');
    }
  }

  /** Mode « Risques bâtiment » (P5/P8) : le bâtiment cible se colore par bande
   *  D03 (pire des aléas argile/radon/sismique BDNB) au lieu de la teinte
   *  accent neutre — passe de « la commune est exposée » à « ce bâtiment
   *  l'est ». Repeint immédiatement les couches déjà en place. */
  function toggleRiskBuildingMode(enabled: boolean) {
    const map = mapRef.current;
    if (!map) return;
    riskBuildingModeRef.current = enabled;
    setRiskBuildingMode(enabled);
    updateBuildingsTarget(map);
  }

  /** Toggle éclairage du style Standard : crépuscule (dusk) ↔ jour (day). */
  function toggleLight() {
    const map = mapRef.current;
    if (!map || !IS_STANDARD_STYLE) return;
    const next = lightPreset === 'dusk' ? 'day' : 'dusk';
    try {
      map.setConfigProperty('basemap', 'lightPreset', next);
      setLightPreset(next);
    } catch {
      // Style non-Standard : la config est ignorée, rien à faire.
    }
  }

  /* Légende bas-gauche (P4) : bandes D03 réellement affichées sur la carte en
   * ce moment (couches œil actives dans le panneau latéral, présents OU
   * absents — un aléa absent activé montre sa couche communale WMS/WFS et
   * compte donc dans la légende), pas la liste fixe des 5 bandes. */
  const visibleAleas = showRisks && report ? (report.aleas || []).filter((a) => visibleLayerKeys.has(a.code)) : [];
  const activeLegendBands: D03Band[] = D03.filter((b) => visibleAleas.some((a) => a.niveau === b.key));

  return (
    <div className="mb-demo-wrap">
      {mapError ? (
        <div className="mb-demo-error"><md-icon>error</md-icon><p>{mapError}</p></div>
      ) : (
        <div ref={containerRef} className="mb-demo-map" />
      )}
      {!mapError && !(points?.length) && activeLegendBands.length > 0 && (
        <div className="mb-map-legend" aria-hidden="true">
          <div className="mb-map-legend-head">
            <md-icon>layers</md-icon>
            <span>{visibleAleas.length} couche{visibleAleas.length > 1 ? 's' : ''} active{visibleAleas.length > 1 ? 's' : ''}</span>
          </div>
          <div className="mb-map-legend-bands">
            {activeLegendBands.map((b) => (
              <div className="mb-map-legend-row" key={b.key}>
                <span className="mb-map-legend-dot" style={{ background: b.color }} />
                <span>{b.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {!mapError && !(points?.length) && (
        <div className="mb-demo-tools" role="group" aria-label="Options de la carte">
          {allowParcels && (
            <button type="button"
              className={`map-3d-toggle analyse${showParcels ? ' active' : ''}`}
              onClick={() => toggleParcels(!showParcels)} aria-pressed={showParcels}
              title={showParcels ? 'Masquer les parcelles cadastrales (IGN)' : 'Afficher les parcelles cadastrales (IGN)'}
              aria-label={showParcels ? 'Masquer les parcelles cadastrales' : 'Afficher les parcelles cadastrales'}>
              <md-icon>grid_on</md-icon>
              <span>Parcelles</span>
            </button>
          )}
          <button type="button"
            className={`map-3d-toggle analyse${is3d ? ' active' : ''}`}
            onClick={() => toggle3D(!is3d)} aria-pressed={is3d}
            title={is3d ? 'Revenir à la vue 2D' : 'Passer en vue 3D (bâtiments extrudés BDNB)'}
            aria-label={is3d ? 'Revenir à la vue 2D' : 'Passer en vue 3D'}>
            <md-icon>view_in_ar</md-icon>
            <span>{is3d ? '2D' : '3D'}</span>
          </button>
          {batimentRiskBand(batimentRisques) && (
            <button type="button"
              className={`map-3d-toggle analyse${riskBuildingMode ? ' active' : ''}`}
              onClick={() => toggleRiskBuildingMode(!riskBuildingMode)} aria-pressed={riskBuildingMode}
              title={riskBuildingMode
                ? 'Revenir à la teinte neutre du bâtiment'
                : 'Colorer le bâtiment cible par son niveau de risque (argile/radon/sismique BDNB)'}
              aria-label={riskBuildingMode ? 'Désactiver le mode risques bâtiment' : 'Activer le mode risques bâtiment'}>
              <md-icon>home_work</md-icon>
              <span>Bâtiment</span>
            </button>
          )}
          {IS_STANDARD_STYLE && (
            <button type="button"
              className={`map-3d-toggle analyse${lightPreset === 'dusk' ? ' active' : ''}`}
              onClick={toggleLight} aria-pressed={lightPreset === 'dusk'}
              title={lightPreset === 'dusk'
                ? 'Passer en mode jour (éclairage standard)'
                : 'Passer en mode crépuscule (coucher de soleil)'}
              aria-label={lightPreset === 'dusk' ? 'Passer en mode jour' : 'Passer en mode crépuscule'}>
              <md-icon>{lightPreset === 'dusk' ? 'light_mode' : 'wb_twilight'}</md-icon>
              <span>{lightPreset === 'dusk' ? 'Jour' : 'Crépuscule'}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Couleur des volumes extrudés ── */
function buildingColorExpr(targetId: string | null | undefined, accent: string): any {
  const ramp: any = ['interpolate', ['linear'], ['coalesce', ['get', 'hauteur_mean'], 0],
    0, '#4f607a', 6, '#778ca8', 12, '#a3b7cc', 20, '#c7d8e6', 32, '#eef4fa'];
  return targetId ? ['case', ['==', ['get', 'batiment_groupe_id'], targetId], accent, ramp] : ramp;
}
