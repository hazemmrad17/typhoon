// =============================================================================
//   TYPHOON — UnifiedMap : carte unique Mapbox GL JS v3 (pas de fallback
//   MapLibre) utilisée par /zone (tableau de bord inondation).
//   Fond de carte : Mapbox Standard seul, en 2D comme en 3D (éclairage
//   « dusk » + landmarks 3D). Le fond sombre CARTO hérité de MapLibre a été
//   retiré : Mapbox est l'unique moteur de fond de carte.
//   · Vue France plein écran (mode overview) : régions, recentrage sur
//     l'adresse diagnostiquée, objets 3D natifs du style Standard.
//   · Bâtiments 3D (BDNB, extrusion par hauteur réelle) + surlignage accent
//     de l'empreinte du bâtiment diagnostiqué (extrusion 3D et teinte 2D)
//   · Couches de risque BRGM (WMS) + WFS Géorisques, à plat — visibilité
//     pilotée par les toggles œil du panneau latéral.
//   · Parcelles cadastrales IGN (toggle).
//   · Particules de vent GFS (raster-particle) selon la carte météo « Wind ».
//   · Resize différé pour suivre les changements de layout.
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
  D03,
  RESOLUTION_BANDS,
  bandForResolution,
  WMS_LAYER_MAP,
  WFS_LAYER_MAP,
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
import {
  clearJourney,
  mountJourney,
} from '../zone/hydroLayer';
import type { Journey } from '../zone/hydroRoute';
import type { FireConeGeometry } from '../zone/hazardSim';
import { quantiseSlab } from '../zone/impactModel';

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
/* Enveloppe d'inondation MODÉLISÉE (étape 2) : un volume d'eau de la hauteur
 * d'eau du moteur, dans l'empreinte RÉELLE de chaque bâtiment, plafonné par
 * sa hauteur BDNB. Aucune surface de crue n'est peinte. */
const BUILDINGS_WATER_LAYER = 'mb-buildings-water';
/* Bâtiments 3D natifs Mapbox (source composite/building — tout le bâti OSM,
 * « vibe ville numérique »). Ajoutés sous la couche BDNB. */
const NATIVE_BUILDINGS_LAYER = 'mb-native-buildings';

/* Parcelles cadastrales IGN (WMS data.geopf.fr) — toggle Analyse. */
const CADASTRE_LAYER = 'mb-cadastre';
const CADASTRE_SOURCE = 'mb-cadastre-src';

/* Vent — Windy Map Forecast API (https://api.windy.com). L'API Windy ne
 * fournit pas de tuiles raster autonomes : elle embarque un moteur Leaflet
 * (libBoot.js + windyInit, clé requise). On superpose donc cette carte Windy
 * à la carte Mapbox et on synchronise sa caméra (centre + zoom). Sans clé
 * VITE_WINDY_API_KEY (définie dans le .env racine), aucun overlay n'est
 * affiché — la carte « Wind » reste vide avec un avertissement console. */
const WINDY_LIB_URL = 'https://api.windy.com/assets/map-forecast/libBoot.js';
/* Leaflet 1.4.0 — requis AVANT libBoot.js (docs Windy « Getting started »). */
const WINDY_LEAFLET_URL = 'https://unpkg.com/leaflet@1.4.0/dist/leaflet.js';
const WINDY_KEY: string = String((import.meta as any).env?.VITE_WINDY_API_KEY || '').trim();

/* Alertes (panneau droit) → indicateurs « cloche » rendus en couches
 * VECTORIELLES (symboles), PAS en marqueurs DOM : sur le globe 3D les
 * marqueurs HTML flottent à l'écran et ne suivent pas la sphère, alors que
 * les symboles épousent la surface, s'éloignent à l'horizon et restent
 * parfaitement synchronisés (mercator comme globe). Icônes générées par
 * niveau (canvas → map.addImage), couleurs VERT→JAUNE→ORANGE→ROUGE. */
const ALERT_BELLS_SOURCE = 'fr-alert-bells-src';
const ALERT_BELLS_LAYER = 'fr-alert-bells';
const ALERT_FOCUS_SOURCE = 'fr-alert-focus-src';
const ALERT_FOCUS_LAYER = 'fr-alert-focus';
const ALERT_LEVEL_COLORS = ['#2fbf71', '#f0c33c', '#ff9f0a', '#ff3b30'];
type AlertPoint = { lat: number; lon: number; name: string; level: number };

/* Emprise de la France métropolitaine — vue d'ensemble de l'étape Adresse
 * (carte derrière le hero tant qu'aucune adresse n'est diagnostiquée). */
const FRANCE_BOUNDS: [[number, number], [number, number]] = [
  [-5.2, 41.2],
  [9.8, 51.2],
];

/* VFX-006 — inclinaison minimale de la caméra cinématique (degrés). Assez
   inclinée pour lire le volume d'eau, pas assez pour donner le vertige : la
   durée d'animation reste courte et l'utilisateur peut toujours ajuster. */
export const VFX_MIN_PITCH_DEG = 55;

/* ── Régions françaises (façon carte EVpin) — GeoJSON embarqué ──
   Contours des 13 régions métropolitaines (jeu data.gouv.fr « Contours
   administratifs » 2025 — IGN Admin Express, généralisation 1000 m,
   licence ODbL 1.0), servis en statique depuis /data (public Vite).
   Le tileset Mapbox « Boundaries v4 » (adm1 + admPoints) n'est pas inclus
   dans le plan du jeton (HTTP 402) : on dessine donc nous-mêmes le
   remplissage, les contours et les libellés en capitales. ── */
const REGIONS_SRC = 'mb-fr-regions';
const REGIONS_CENTROIDS_SRC = 'mb-fr-regions-centroids';
const REGIONS_FILL = 'mb-fr-regions-fill';
const REGIONS_LINE = 'mb-fr-regions-line';
const REGIONS_LABEL = 'mb-fr-regions-label';
const REGIONS_URL = `${(import.meta as any).env?.BASE_URL || '/'}data/regions-france.geojson`;

/** Hauteur d'eau dessinée : la profondeur modélisée, plafonnée par la hauteur
 *  RÉELLE de chaque bâtiment (BDNB) — au-delà, il n'y a plus d'immeuble à
 *  noyer. Exprimée en littéraux (`case`, disponible sur toutes les versions du
 *  style, plutôt que `min`, plus récent) : régler l'épaisseur ne réécrit donc
 *  aucune géométrie. */
function waterHeightExpr(slabM: number): any {
  return [
    'case',
    ['>', slabM, ['coalesce', ['get', 'hauteur_mean'], 0]],
    ['coalesce', ['get', 'hauteur_mean'], 0],
    slabM,
  ];
}

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

/* ── Effet pluie Mapbox (v3.9+) ──
   `setRain` rend de la pluie plein écran sur le style Standard — la façon
   native (doc Mapbox) d'ajouter une « précipitation » visible. On l'active
   dès que la vue météo est active (adresse diagnostiquée → flatProjection),
   c'est-à-dire quelle que soit la carte métrique choisie (temp/pression/
   pluie/vent) : toutes racontent la météo, la pluie y est « relatable ».
   La densité est zoom-dépendante (révélée 11→13) pour ne pas pleuvoir à
   la vue France dézoomée. Sans effet sur les styles classiques. */
const RAIN_CONFIG: Parameters<mapboxgl.Map['setRain']>[0] = {
  density: ['interpolate', ['linear'], ['zoom'], 11, 0.0, 13, 0.5],
  intensity: 1.0,
  color: '#a8adbc',
  opacity: 0.7,
  vignette: ['interpolate', ['linear'], ['zoom'], 11, 0.0, 13, 1.0],
  'vignette-color': '#464646',
  direction: [0, 80],
  'droplet-size': [2.6, 18.2],
  'distortion-strength': 0.7,
  'center-thinning': 0,
};

function applyRainEffect(map: mapboxgl.Map, on: boolean) {
  if (!IS_STANDARD_STYLE) return;
  try {
    map.setRain(on ? RAIN_CONFIG : null);
  } catch {
    // Style classique ou mapbox-gl < 3.9 : propriété ignorée, rien à faire.
  }
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

/* ── Vue d'ensemble (étape Adresse) — régions façon EVpin ──
   Remplit les 13 régions d'une teinte discrète, trace leurs contours et pose
   leur nom en capitales (centroïde du plus grand polygone). Non bloquant : si
   le GeoJSON n'est pas disponible, la carte standard reste intacte. */
async function addFranceOverviewLayers(
  map: mapboxgl.Map,
  onRegionSelect?: (nom: string) => void
) {
  try {
    if (map.getLayer(REGIONS_FILL)) return;
    const res = await fetch(REGIONS_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const fc = await res.json();
    if (!fc?.features?.length) return;
    drawFranceRegions(map, fc, onRegionSelect);
  } catch (err) {
    // Fichier absent (réseau, dist…) : la vue d'ensemble reste la carte
    // standard. Jamais bloquant.
    console.warn('[mapbox] régions France indisponibles:', err);
  }
}

/** Centre approché d'un polygone (centroïde du plus grand anneau). */
function regionLabelPoint(feature: any): [number, number] | null {
  const geom = feature?.geometry;
  const polys: any[] =
    geom?.type === 'Polygon'
      ? [geom.coordinates]
      : geom?.type === 'MultiPolygon'
        ? geom.coordinates
        : [];
  let best: [number, number] | null = null;
  let bestArea = -1;
  for (const poly of polys) {
    const ring: number[][] = poly?.[0];
    if (!ring || ring.length < 4) continue;
    let a2 = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const x1 = ring[i][0];
      const y1 = ring[i][1];
      const x2 = ring[i + 1][0];
      const y2 = ring[i + 1][1];
      const cross = x1 * y2 - x2 * y1;
      a2 += cross;
      cx += (x1 + x2) * cross;
      cy += (y1 + y2) * cross;
    }
    if (Math.abs(a2) > bestArea) {
      bestArea = Math.abs(a2);
      best = [cx / (3 * a2), cy / (3 * a2)];
    }
  }
  return best;
}

function drawFranceRegions(
  map: mapboxgl.Map,
  fc: any,
  onRegionSelect?: (nom: string) => void
) {
  try {
    if (map.getSource(REGIONS_SRC)) return;
    const light = !!document.querySelector('.zone-app')?.classList.contains('theme-light');
    /* Remplissage neutre des régions (pas la teinte accent / pas de dégradé
       violet) : la carte reste lisible, le survol éclaircit légèrement la
       surface pour la sélection. */
    const tint = light ? 'rgba(120,132,148,0.12)' : 'rgba(150,165,184,0.10)';
    const hover = light ? 'rgba(120,132,148,0.24)' : 'rgba(150,165,184,0.22)';
    const lineColor = light ? '#5b6470' : '#9fafc2';
    const labelColor = light ? '#1c222b' : '#f2f6fc';
    const halo = light ? 'rgba(255,255,255,0.92)' : 'rgba(8,12,18,0.85)';
    const layerBase: any = {
      source: REGIONS_SRC,
      slot: IS_STANDARD_STYLE ? 'middle' : undefined,
      minzoom: 3,
      maxzoom: 8,
    };

    map.addSource(REGIONS_SRC, {
      type: 'geojson',
      data: fc,
      // Ids numériques pour le feature-state de survol.
      generateId: true,
    });

    map.addLayer({
      ...layerBase,
      id: REGIONS_FILL,
      type: 'fill',
      paint: {
        'fill-color': [
          'case',
          ['boolean', ['feature-state', 'hover'], false],
          hover,
          tint,
        ],
      },
    } as any);

    map.addLayer({
      ...layerBase,
      id: REGIONS_LINE,
      type: 'line',
      paint: {
        'line-color': lineColor,
        'line-width': 1.2,
        'line-opacity': light ? 0.7 : 0.85,
      },
    } as any);

    /* Libellés : un point par région (centroïde du plus grand polygone),
       rendu en capitales espacées — comme les « états » d'EVpin. */
    const pts: any[] = [];
    for (const f of fc.features || []) {
      const c = regionLabelPoint(f);
      if (!c) continue;
      pts.push({
        type: 'Feature',
        properties: { nom: f.properties?.nom ?? '' },
        geometry: { type: 'Point', coordinates: c },
      });
    }
    map.addSource(REGIONS_CENTROIDS_SRC, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: pts },
    });
    map.addLayer({
      id: REGIONS_LABEL,
      type: 'symbol',
      source: REGIONS_CENTROIDS_SRC,
      slot: IS_STANDARD_STYLE ? 'middle' : undefined,
      minzoom: 4,
      maxzoom: 9,
      layout: {
        'text-field': ['get', 'nom'],
        'text-font': ['DIN Pro Bold', 'Arial Unicode MS Regular'],
        'text-size': 12,
        'text-transform': 'uppercase',
        'text-max-width': 9,
        'text-letter-spacing': 0.14,
        /* Toutes les régions sont nommées en toutes lettres, par-dessus la
           cartographie (façon EVpin) : on force le chevauchement — le halo
           garde la lecture propre. */
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color': labelColor,
        'text-halo-color': halo,
        'text-halo-width': 1.2,
      },
    } as any);

    /* Survol : la région sous le pointeur passe en aplat accent (façon
       « état sélectionné » d'EVpin). */
    let hovered: number | string | null = null;
    const clearHover = () => {
      if (hovered == null) return;
      map.setFeatureState({ source: REGIONS_SRC, id: hovered }, { hover: false });
      hovered = null;
    };
    map.on('mousemove', REGIONS_FILL, (e) => {
      const f = e.features && e.features[0];
      if (!f || f.id == null) return;
      if (hovered !== f.id) {
        clearHover();
        hovered = f.id;
        map.setFeatureState({ source: REGIONS_SRC, id: f.id }, { hover: true });
      }
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', REGIONS_FILL, () => {
      clearHover();
      map.getCanvas().style.cursor = '';
    });

    /* Clic sur une région : remonte le nom (placeholder de recherche). */
    if (onRegionSelect) {
      map.on('click', REGIONS_FILL, (e) => {
        const f = e.features && e.features[0];
        const nom = f?.properties?.nom;
        if (nom) onRegionSelect(nom);
      });
    }
  } catch (err) {
    console.warn('[mapbox] rendu régions France:', err);
  }
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
   *  (day) demandé pour « Bien & contexte » ; « night » pour la vue France
   *  de l'étape Adresse (thème sombre) ; undefined = ne rien forcer. */
  defaultLightPreset?: 'day' | 'dusk' | 'dawn' | 'night';
  /** Nombre max de bâtiments chargés par bbox (0 = tous, jusqu'à épuisement).
   *  Cartographie : tous. Analyse : 200 (la carte y est secondaire). */
  buildingsLimit?: number;
  /** Enveloppe d'inondation MODÉLISÉE (étape 2) : hauteur d'eau du moteur (m)
   *  dessinée dans l'empreinte BDNB réelle de chaque bâtiment de la vue,
   *  plafonnée par sa hauteur réelle. `null` = rien à peindre (sous le seuil
   *  d'infrastructure du moteur, ou hors de l'étape 2) — la couche est masquée. */
  impact?: { slabM: number; color: string } | null;
  /** 3D au démarrage. */
  initial3D?: boolean;
  fitZoom?: number;
  /** Mode « points » (Portfolio) : une pastille par adresse colorée par
   *  bande D03. Quand fourni (non vide), remplace le rendu rapport. */
  points?: PortfolioPoint[];
  /** Mode « vue d'ensemble » (étape Adresse) : carte France sans chrome ni
   *  couches, en arrière-plan du hero de recherche. Aucun rapport requis. */
  overview?: boolean;
  /** Trajet de l'eau (étape 2) : parcours RÉEL reconstruit sur le réseau
   *  hydrographique IGN BD TOPO (cf. hydroRoute.ts). Non nul → les couches du
   *  trajet sont montées (tracé, bassin versant, extrémités, marqueur). */
  journey?: Journey | null;
  /** Géométrie du bassin versant contributeur réel (polygone BD TOPO). */
  basinGeometry?: GeoJSON.Geometry | null;
  /** VFX-006 — mode cinématique (constitution §2.1). En VFX : l'overlay Windy
   *  est désactivé (il force un rendu plat en mercator, incompatible avec la
   *  caméra 3D) et l'inclinaison est forcée à ≥ 55°. Sortir du mode restaure
   *  la politique météo normale : le mode data n'est pas altéré. */
  vfxMode?: boolean;
  /** SCN-021 — cône d'exposition FEU (aléa diagnostiqué présent uniquement) :
   *  polygone GeoJSON orienté par la direction du vent RÉEL au pic de rafales.
   *  `null` = pas de météo, ou aléa non présent à l'adresse → rien n'est
   *  dessiné (aucun cône inventé). La forme (portée/ouverture) est une
   *  hypothèse : la légende du panneau le dit. */
  fireCone?: FireConeGeometry | null;
  /** Clic sur une région de la carte France (mode overview) — Zone.tsx
   *  s'en sert pour afficher la région dans le placeholder de recherche. */
  onRegionSelect?: (nom: string) => void;
  /** Point à recentrer en mode overview (adresse diagnostiquée) : la carte
   *  vole sur le point avec une pastille ; null = retour au cadrage France. */
  focus?: { lat: number; lon: number } | null;
  /** Carte météo active de la console (temp/wind/pressure/rainfall) — pilote
   *  la couche météo sur la carte : vent en particules GFS natives ;
   *  température / pression / pluie en calque Open-Meteo (raster-om). */
  weatherMetric?: string;
  /** Index de l'heure de prévision (time-aware) — 0 = première valid_time. */
  weatherTime?: number;
  /** Mode « risques bâtiment » (panneau latéral ouvert) : même en mode
   *  overview (France), surligner l'empreinte du bâtiment diagnostiqué
   *  (extrusion 3D + épingle + cadrage) — pilote depuis Zone.tsx. */
  riskHighlight?: boolean;
  /** Projection à plat (mercator) : les tuiles météo OM sont plates (Mercator) —
   *  quand l'overlay météo est affiché, on passe la carte en mercator pour que
   *  l'overlay s'aligne 1:1 (pan/zoom/rotation) au lieu de dériver sur la
   *  sphère du globe 3D. true = vue analyse/risque ; false = globe (étape 1). */
  flatProjection?: boolean;
  /** Flood Mapping (Vigicrues) : bascule une couche GeoJSON des tronçons de
   *  vigilance crues (InfoVigiCru.geojson) colorés par niveau — la « carte
   *  inondation » réelle de la France. */
  showFloodVigilance?: boolean;
  /** Alerte sélectionnée depuis le panneau « Alertes » : la carte vole vers
   *  le tronçon et pose un indicateur animé de la couleur du niveau. */
  alertFocus?: { lat: number; lon: number; name: string; level: number } | null;
  /** Toutes les alertes affichées par le panneau droit : un indicateur coloré
   *  (cloche) est posé sur la carte pour chaque tronçon de vigilance. */
  alertMarkers?: { lat: number; lon: number; name: string; level: number }[];
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
  impact = null,
  initial3D = false,
  fitZoom = 16.5,
  points,
  overview = false,
  journey = null,
  basinGeometry = null,
  fireCone = null,
  vfxMode = false,
  onRegionSelect,
  focus = null,
  weatherMetric,
  weatherTime = 0,
  riskHighlight = false,
  flatProjection = false,
  showFloodVigilance = false,
  alertFocus = null,
  alertMarkers = [],
}: UnifiedMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const mapReadyRef = useRef(false);
  /* Projection courante voulue (globe avant diagnostic, mercator après) —
     lue par les handlers asynchrones (onload) via le ref, pas la closure. */
  const flatProjectionRef = useRef(flatProjection);
  flatProjectionRef.current = flatProjection;
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
  const riskHighlightRef = useRef(riskHighlight);
  riskHighlightRef.current = riskHighlight;
  const riskBuildingModeRef = useRef(false);
  const visibleKeysRef = useRef(visibleLayerKeys);
  visibleKeysRef.current = visibleLayerKeys;
  const buildingsLimitRef = useRef(buildingsLimit);
  buildingsLimitRef.current = buildingsLimit;
  /* Couches de risque WMS/WFS créées par `renderReport` : code d'aléa →
   * ids de couches (fill/outline/raster/circle), pour piloter leur
   * visibilité depuis les toggles œil du panneau latéral. */
  const layerIdsByKeyRef = useRef<Map<string, string[]>>(new Map());
  const impactRef = useRef(impact);
  impactRef.current = impact;
  /* Vue d'analyse (étape 2) : c'est là que le bâti RÉEL de la scène doit être
     chargé (l'eau se peint dans son empreinte, et le bâtiment cible s'y
     surligne) — la vue d'ensemble, elle, vit sur le cadrage France. */
  const riskHintRef = useRef(riskHighlight);
  riskHintRef.current = riskHighlight;
  /* Une enveloppe est-elle demandée ? SCN-002 : `impact` vient de
     `mapImpactFromDepth`, donc il est non null dès qu'une profondeur > 0 est
     modélisée — l'eau se peint AVANT le seuil de dommages (0,3 m), qui ne
     gouverne que les compteurs. `null` reste un état : rien n'est modélisé. */
  const impactOn = impact !== null;
  /* Épaisseur déjà écrite dans la couche : évite un setPaintProperty par tick
     de curseur quand le pas de 5 cm n'a pas bougé. */
  const impactSlabRef = useRef(-1);
  /* Emprise du bâti déjà chargée (+ adresse cible) — cf. `loadBuildings`. */
  const loadedBboxRef = useRef<{
    west: number; south: number; east: number; north: number; target: string | null;
  } | null>(null);
  const markerRef = useRef<mapboxgl.Marker | null>(null);
  const popupRef = useRef<mapboxgl.Popup | null>(null);
  const pinElRef = useRef<HTMLDivElement | null>(null);
  /* Pastille du point recentré en mode overview (adresse diagnostiquée). */
  const focusMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const focusRef = useRef(focus);
  focusRef.current = focus;

  const [showParcels, setShowParcels] = useState(defaultParcels);
  const [riskBuildingMode, setRiskBuildingMode] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  /* Éclairage du style Standard : « crépuscule » (dusk) par défaut, forcé en
   * « jour » (day) sur l'étape « Bien & contexte » via `defaultLightPreset`
   * — toggle manuel via setConfigProperty. Le ref sert à la création de la
   * carte (le handler de load est une fermeture du premier rendu). */
  const [lightPreset, setLightPreset] = useState<'day' | 'dusk' | 'dawn' | 'night'>(defaultLightPreset ?? 'dusk');
  const lightPresetRef = useRef(lightPreset);
  lightPresetRef.current = lightPreset;
  const showParcelsRef = useRef(showParcels);
  showParcelsRef.current = showParcels;
  const weatherMetricRef = useRef(weatherMetric);
  weatherMetricRef.current = weatherMetric;
  const weatherTimeRef = useRef(weatherTime);
  weatherTimeRef.current = weatherTime;
  /* Overlay Windy (carte « Wind ») : la carte météo Windy (Leaflet) est
     superposée à la carte Mapbox et synchronisée en caméra. L'instance est
     créée paresseusement (script libBoot.js + windyInit) et conservée : on
     l'affiche/masque plutôt que de la recréer à chaque sélection. */
  const windyRef = useRef<{
    el: HTMLDivElement | null;
    api: unknown | null;
    map: unknown | null;
    lib: Promise<void> | null;
    seq: number;
    warnedNoKey: boolean;
    onMove: (() => void) | null;
    /* Sync inversé en « mode météo » : Windy devient la carte, Mapbox le suit.
       onWindyMove = listener Leaflet 'move' → Mapbox ; weatherMode = true tant
       que Windy est la carte affichée (Mapbox masqué). */
    onWindyMove: (() => void) | null;
    weatherMode: boolean;
    prevRot: { dragRotate: boolean; touchPitch: boolean } | null;
  }>({
    el: null,
    api: null,
    map: null,
    lib: null,
    seq: 0,
    warnedNoKey: false,
    onMove: null,
    onWindyMove: null,
    weatherMode: false,
    prevRot: null,
  });
  const onRegionSelectRef = useRef(onRegionSelect);
  onRegionSelectRef.current = onRegionSelect;
  const showRisksRef = useRef(showRisks);
  showRisksRef.current = showRisks;

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
          /* Vue France de l'étape Adresse : les régions sont dessinées par nos
           * propres couches GeoJSON (addFranceOverviewLayers). Les objets 3D
           * natifs du style Standard (bâtiments) restent actifs : ils
           * apparaissent dès qu'on zoome sur une ville (toggle 3D/2D inclus). */
          show3dObjects: true,
        },
      },
      center,
      zoom: rep ? fitZoom : 5,
      pitch: is3dRef.current ? 55 : 0,
      bearing: is3dRef.current ? -20 : 0,
      /* Vue analyse/risque = mercator (plat) pour aligner l'overlay météo ;
         étape Adresse = globe 3D (« planète »). On repasse à la projection
         voulue plus tard via l'effet `flatProjection`. */
      projection: flatProjection ? 'mercator' : 'globe',
      antialias: true,
      minZoom: 3,
      maxZoom: 19,
      attributionControl: true,
    });
    if (!overview) {
      map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'bottom-right');
    }
    mapRef.current = map;
    // DEBUG(temp): expose map for inspection.
    (window as any).__mbMap = map;

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
      // Vue d'ensemble (étape Adresse) : caler la France, sans couches
      // métier ni bâtiments BDNB — le rendu rapport n'a rien à afficher.
      if (overview) {
        if (IS_STANDARD_STYLE) {
          try {
            // Rappel au load : éclairage garanti même si la config de
            // création n'a pas été prise en compte par le style.
            map.setConfigProperty('basemap', 'lightPreset', lightPresetRef.current);
          } catch {
            /* style classique : config ignorée, rien à faire */
          }
        }
        // Régions françaises (GeoJSON embarqué) puis cadrage : la France
        // occupe la vue (marge réduite), façon carte EVpin — sauf si un
        // focus (adresse diagnostiquée avant le load) est déjà en attente.
        void addFranceOverviewLayers(map, onRegionSelectRef.current);
        const f0 = focusRef.current;
        if (f0) {
          if (!focusMarkerRef.current) {
            const el = document.createElement('div');
            el.className = 'fr-focus-marker';
            focusMarkerRef.current = new mapboxgl.Marker({ element: el })
              .setLngLat([f0.lon, f0.lat])
              .addTo(map);
          }
          map.easeTo({ center: [f0.lon, f0.lat], zoom: 14.5, duration: 600 });
        } else {
          map.fitBounds(FRANCE_BOUNDS, { padding: 12, duration: 0 });
        }
        // Projection : si une adresse était déjà diagnostiquée au montage, la
        // bascule globe→mercator demandée par l'effet n'a pas pu s'appliquer
        // (carte pas prête) — on la force ici, au load.
        try {
          map.setProjection(flatProjectionRef.current ? 'mercator' : 'globe');
        } catch {
          /* ignore */
        }
        // Couche météo (vent / température / pression / pluie) si une carte
        // est déjà active au montage (le ref lit l'état courant, fermeture du
        // 1er rendu). N'appliquée QUE si une adresse est déjà diagnostiquée
        // (flatProjection) : avant cela, aucune couche météo n'est affichée
        // par défaut — elle apparaît après le diagnostic.
        if (flatProjectionRef.current) {
          applyWeatherLayer(map, weatherMetricRef.current, weatherTimeRef.current);
          applyRainEffect(map, weatherMetricRef.current === 'rainfall');
        } else {
          applyRainEffect(map, false);
        }
        return;
      }
      ensureCadastreLayer(map);
      ensureNativeBuildings(map);
      ensureBuildingsLayer(map);
      updateBuildingsTarget(map);
      void loadBuildings(map);
      if (showRisks) renderReport(map, latestReportRef.current);
    });

    map.on('moveend', () => {
      /* Le bâti suit le cadrage en 3D, en vue d'analyse (bâtiment cible) et
         tant qu'une enveloppe d'inondation peut se peindre dans son empreinte. */
      if (!is3dRef.current && !impactRef.current && !riskHintRef.current) return;
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
      focusMarkerRef.current?.remove();
      focusMarkerRef.current = null;
      disposeWindy();
      map.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Mode overview : recentrage sur l'adresse diagnostiquée (focus) ──
     Clé stable (lat,lon) : un même point ne relance pas le vol ; null
     (focusKey vide) ramène la vue sur la France entière. */
  const focusKey = focus ? `${focus.lat.toFixed(5)},${focus.lon.toFixed(5)}` : '';
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current || !overview) return;
    if (focusKey) {
      const f = focus;
      if (!f) return;
      if (!focusMarkerRef.current) {
        const el = document.createElement('div');
        el.className = 'fr-focus-marker';
        focusMarkerRef.current = new mapboxgl.Marker({ element: el })
          .setLngLat([f.lon, f.lat])
          .addTo(map);
      } else {
        focusMarkerRef.current.setLngLat([f.lon, f.lat]);
      }
      map.easeTo({ center: [f.lon, f.lat], zoom: 14.5, duration: 900 });
    } else {
      focusMarkerRef.current?.remove();
      focusMarkerRef.current = null;
      map.fitBounds(FRANCE_BOUNDS, { padding: 12, duration: 900 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview, focusKey]);

  /* ── Mode « risques bâtiment » (panneau ouvert) ──
     En overview (France), l'init de la carte ne crée ni couches BDNB ni pin :
     à l'ouverture du panneau on les crée et on cadre le bâtiment ; à la
     fermeture on retire le pin et on revient au cadrage France. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current || !overview) return;
    if (riskHighlightRef.current) {
      ensureBuildingsLayer(map);
      /* En overview le mode 3D est éteint par défaut (extrusion BDNB en
         « none ») : on force la visibilité des couches du bâtiment cible
         pour qu'il ressorte même sans basculer tout le mode 3D. */
      for (const id of [BUILDINGS_LAYER, BUILDINGS_OUTLINE_LAYER]) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'visible');
      }
      if (map.getLayer(BUILDINGS_2D_LAYER)) map.setLayoutProperty(BUILDINGS_2D_LAYER, 'visibility', 'none');
      updateBuildingsTarget(map);
      void loadBuildings(map);
      const b = currentBatiment();
      if (b?.geom_groupe) {
        try {
          const wgs = geomToWgs84(b.geom_groupe as Record<string, unknown>);
          const c = polygonCenter(wgs?.coordinates);
          if (c) map.easeTo({ center: c, zoom: fitZoom, pitch: 55, bearing: -20, duration: 900 });
        } catch { /* */ }
      }
    } else {
      map.fitBounds(FRANCE_BOUNDS, { padding: 12, duration: 900 });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [riskHighlight, batiment, report]);

  /* ── Changement de bâtiment/adresse ── */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current) return;      updateBuildingsTarget(map);
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

  /* ── Gros plan (step Cartographie : marqueur + popup + calques aléas) ──
     Se déclenche quand showRisks passe à true (onglet Cartographie/Synthèse)
     OU quand le report change. Si showRisks est true mais le map n'est pas
     encore prêt, le handler onload s'en charge (voir plus bas). */
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

  /* ── Rattrapage : si showRisks est vrai au montage du composant (reload,
     retour depuis un autre onglet) et que le map est déjà prêt, on
     force le rendu. Sans cet effet, un showRisks=true dès le premier
     render ne déclenche pas renderReport (mapReadyRef encore false). */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current || !showRisks) return;
    // Petit délai pour laisser le temps au style de finir de se charger
    const timer = window.setTimeout(() => {
      const m = mapRef.current;
      if (m && showRisksRef.current) {
        renderReport(m, latestReportRef.current);
      }
    }, 100);
    return () => window.clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showRisks, report]);

  /* ── Couche météo (vent / température / pression / pluie) ──
     Re-applique la couche quand la carte météo change (ou l'heure de
     prévision, pour le mode time-aware). Si la carte n'est pas encore prête
     (montage), le handler onload applique l'état via le ref. */
  /* Projection : globe 3D (avant diagnostic) ↔ mercator plat (dès qu'une
     adresse est diagnostiquée — l'overlay météo, tuiles plates, ne peut pas
     suivre la courbure du globe). On bascule à la volée sans forcer le
     rechargement de la carte : setProjection garde la caméra. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    try {
      map.setProjection(flatProjection ? 'mercator' : 'globe');
    } catch {
      /* carte pas encore prête : le handler onload reprendra */
    }
    if (flatProjection) {
      if (mapReadyRef.current) applyWeatherLayer(map, weatherMetricRef.current, weatherTimeRef.current);
    } else {
      disableWindyOverlay(map);
    }
  }, [flatProjection]);

  /* ── Effet pluie plein écran (setRain, style Standard) ──
     Actif UNIQUEMENT quand la carte « Rainfall » est sélectionnée (et que la
     vue météo est active : adresse diagnostiquée → flatProjection). Retiré
     sur les autres cartes (temp/pression/vent), au retour globe, ou quand
     la carte est désélectionnée (double-clic). */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current) return;
    applyRainEffect(map, flatProjection && weatherMetric === 'rainfall');
  }, [flatProjection, weatherMetric]);

  /* ── Flood Mapping (Vigicrues) : affiche/masque les tronçons de vigilance
     crues colorés par niveau sur la carte. Basculé par le toggle FLOOD
     MAPPING de la console. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current) return;
    if (showFloodVigilance) addFloodVigilanceLayer(map);
    else removeFloodVigilanceLayer(map);
  }, [showFloodVigilance]);

  /* ── Alertes → couches VECTORIELLES (synchronisées avec le globe) ──
     Les anciens marqueurs DOM flottaient à l'écran sur le globe 3D. On rend
     maintenant les cloches + l'indicateur ciblé en symboles mapbox : ils
     épousent la sphère, restent ancrés à leur coordonnée et disparaissent à
     l'horizon comme le reste de la carte. */

  /* Sprite « cloche » colorée par niveau → ImageData (map.addImage). */
  function makeBellSprite(color: string): ImageData {
    const S = 64;
    const cv = document.createElement('canvas');
    cv.width = S;
    cv.height = S;
    const g = cv.getContext('2d');
    if (!g) return new ImageData(S, S);
    g.clearRect(0, 0, S, S);
    // Halo doux autour de la pastille.
    g.globalAlpha = 0.25;
    g.beginPath();
    g.arc(S / 2, S / 2, 27, 0, Math.PI * 2);
    g.fillStyle = color;
    g.fill();
    g.globalAlpha = 1;
    // Pastille pleine + liseré clair.
    g.beginPath();
    g.arc(S / 2, S / 2, 17, 0, Math.PI * 2);
    g.fillStyle = color;
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    g.stroke();
    // Glyphe « cloche » (Material notifications) en blanc.
    g.translate(8, 8);
    g.scale(2, 2);
    g.fillStyle = '#ffffff';
    const p = new Path2D(
      'M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z'
    );
    g.fill(p);
    return g.getImageData(0, 0, S, S);
  }

  /* Enregistre une icône `fr-bell-{1..4}` par niveau (idempotent). */
  function ensureAlertIcons(map: mapboxgl.Map) {
    for (let l = 1; l <= 4; l += 1) {
      const id = `fr-bell-${l}`;
      if (!map.hasImage(id)) map.addImage(id, makeBellSprite(ALERT_LEVEL_COLORS[l - 1]));
    }
  }

  const alertLevel = (l: number) => (l >= 1 && l <= 4 ? l : 1);

  /* Met à jour les couches cloches (toutes les alertes) + indicateur ciblé. */
  function updateAlertLayers(map: mapboxgl.Map, bells: AlertPoint[], focus: AlertPoint | null) {
    try {
      const bellData: GeoJSON.FeatureCollection = {
        type: 'FeatureCollection',
        features: bells.map((a) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [a.lon, a.lat] },
          properties: { level: alertLevel(a.level) },
        })),
      };
      const bellSrc = map.getSource(ALERT_BELLS_SOURCE) as mapboxgl.GeoJSONSource | undefined;
      if (bells.length > 0) {
        if (!bellSrc) {
          map.addSource(ALERT_BELLS_SOURCE, { type: 'geojson', data: bellData });
          map.addLayer({
            id: ALERT_BELLS_LAYER,
            type: 'symbol',
            source: ALERT_BELLS_SOURCE,
            layout: {
              'icon-image': [
                'match',
                ['get', 'level'],
                4,
                'fr-bell-4',
                3,
                'fr-bell-3',
                2,
                'fr-bell-2',
                'fr-bell-1',
              ],
              'icon-size': ['interpolate', ['linear'], ['zoom'], 0, 0.6, 6, 0.5, 12, 0.4],
              'icon-allow-overlap': true,
              'icon-ignore-placement': true,
            },
          });
        } else {
          bellSrc.setData(bellData);
        }
      } else if (bellSrc) {
        if (map.getLayer(ALERT_BELLS_LAYER)) map.removeLayer(ALERT_BELLS_LAYER);
        map.removeSource(ALERT_BELLS_SOURCE);
      }

      const fData: GeoJSON.FeatureCollection = {
        type: 'FeatureCollection',
        features: focus
          ? [
              {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [focus.lon, focus.lat] },
                properties: { name: focus.name, level: alertLevel(focus.level) },
              },
            ]
          : [],
      };
      const fSrc = map.getSource(ALERT_FOCUS_SOURCE) as mapboxgl.GeoJSONSource | undefined;
      if (focus) {
        if (!fSrc) {
          map.addSource(ALERT_FOCUS_SOURCE, { type: 'geojson', data: fData });
          map.addLayer({
            id: ALERT_FOCUS_LAYER,
            type: 'symbol',
            source: ALERT_FOCUS_SOURCE,
            layout: {
              'icon-image': [
                'match',
                ['get', 'level'],
                4,
                'fr-bell-4',
                3,
                'fr-bell-3',
                2,
                'fr-bell-2',
                'fr-bell-1',
              ],
              'icon-size': ['interpolate', ['linear'], ['zoom'], 0, 1.05, 6, 0.9, 12, 0.75],
              'icon-allow-overlap': true,
              'icon-ignore-placement': true,
              'text-field': ['get', 'name'],
              'text-size': ['interpolate', ['linear'], ['zoom'], 3, 11, 9, 14],
              'text-anchor': 'bottom',
              'text-offset': [0, -1.8],
              'text-allow-overlap': true,
              'text-font': ['Arial Unicode MS Regular'],
              'text-max-width': 16,
            },
            paint: {
              'text-color': '#ffffff',
              'text-halo-color': 'rgba(0,0,0,0.8)',
              'text-halo-width': 1.6,
            },
          });
        } else {
          fSrc.setData(fData);
        }
      } else if (fSrc) {
        if (map.getLayer(ALERT_FOCUS_LAYER)) map.removeLayer(ALERT_FOCUS_LAYER);
        map.removeSource(ALERT_FOCUS_SOURCE);
      }
    } catch (err) {
      console.warn('[alert] couches:', err);
    }
  }

  /* ── Alertes affichées → cloches vectorielles sur la carte ── */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current) return;
    try {
      ensureAlertIcons(map);
    } catch (err) {
      console.warn('[alert] icônes:', err);
    }
    updateAlertLayers(map, alertMarkers, alertFocus);
  }, [alertMarkers, alertFocus]);

  /* ── Clic « Voir » sur une alerte : voler vers le tronçon + allumer la
     couche de vigilance pour contextualiser (l'indicateur ciblé est posé par
     la couche `updateAlertLayers` ci-dessus). */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current) return;
    if (!alertFocus) return;
    const { lat, lon } = alertFocus;
    if (!showFloodVigilance) addFloodVigilanceLayer(map);
    map.easeTo({
      center: [lon, lat],
      zoom: Math.max(map.getZoom(), 8),
      duration: 1100,
      essential: true,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alertFocus]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current) return;
    /* L'overlay météo (Windy) ne s'applique qu'en mercator (flatProjection) :
       sur le globe il ne peut pas suivre la courbure de la sphère. */
    if (flatProjection) applyWeatherLayer(map, weatherMetricRef.current, weatherTimeRef.current);
    else disableWindyOverlay(map);
  }, [weatherMetric, weatherTime]);

  /* ── VFX-006 — politique de caméra du mode cinématique ──
     Windy et la caméra 3D sont MUTUELLEMENT EXCLUSIFS (§2.1, [test]) : Windy
     force un rendu métrique plat. On libère donc la couche météo à l'entrée en
     VFX et on incline la caméra. En sortie, l'effet de la prop `weatherMetric`
     ci-dessus reprend la main : la politique data est restaurée telle quelle. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current) return;
    if (!vfxMode) return;
    disableWindyOverlay(map);
    if (map.getPitch() < VFX_MIN_PITCH_DEG) {
      map.easeTo({ pitch: VFX_MIN_PITCH_DEG, duration: 700, essential: true });
    }
  }, [vfxMode]);

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

  /* ── Trajet de l'eau (étape 2) : le PARCOURS RÉEL, dessiné sur la carte.
     Ce qui est dessiné est de la géographie réelle (IGN BD TOPO) : tracé du
     cours d'eau, bassin versant contributeur, extrémités et site analysé.
     Aucune surface d'eau n'est peinte : le trajet dit par où l'eau passe et
     où la reconstruction s'arrête, il ne simule pas de niveau. ── */

  /* Montage / démontage des couches du trajet. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current) return;
    if (!journey) {
      clearJourney(map);
      return;
    }
    const rep = latestReportRef.current;
    const site = rep ? { lon: rep.lon, lat: rep.lat } : null;
    mountJourney(map, journey, site, basinGeometry ?? null);
    return () => {
      /* mapReadyRef est l'indicateur de vie de la carte : l'effet de création
         (déclaré PLUS HAUT dans le composant) exécute son nettoyage avant
         celui-ci et le fait retomber à false juste avant map.remove().
         Sans ce garde, clearJourney() appelait getLayer/getSource sur une
         carte détruite, levait une exception — et une exception dans un
         nettoyage d'effet démonte tout l'arbre React. C'est ce qui laissait
         la page /report entièrement blanche à l'arrivée depuis l'étape 3,
         alors qu'un chargement direct de /report fonctionnait.
         alors qu'un chargement direct de /report fonctionnait. */
      if (mapReadyRef.current) clearJourney(map);
    };
  }, [journey, basinGeometry]);

  /* ── SCN-021 — cône de FEU sur la carte (aléa feu diagnostiqué) ──
     Le panneau garde sa vignette SVG ; la carte porte la géométrie réelle :
     polygone ancré au bien, orienté par la direction du vent au pic de
     rafales RÉELLE. Couleurs volontairement chaudes et translucides : une
     zone d'EXPOSITION, pas une emprise de flammes. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current) return;
    const SRC = 'fire-cone-src';
    const FILL = 'fire-cone-fill';
    const LINE = 'fire-cone-line';

    if (!fireCone) {
      if (map.getLayer(FILL)) map.removeLayer(FILL);
      if (map.getLayer(LINE)) map.removeLayer(LINE);
      if (map.getSource(SRC)) map.removeSource(SRC);
      return;
    }

    const data: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [fireCone] };
    const src = map.getSource(SRC) as mapboxgl.GeoJSONSource | undefined;
    if (src) {
      src.setData(data);
      return;
    }
    map.addSource(SRC, { type: 'geojson', data });
    map.addLayer({
      id: FILL,
      type: 'fill',
      source: SRC,
      paint: { 'fill-color': '#ff7043', 'fill-opacity': 0.18 },
    });
    map.addLayer({
      id: LINE,
      type: 'line',
      source: SRC,
      paint: { 'line-color': '#ff7043', 'line-width': 1.5, 'line-dasharray': [2, 2] },
    });
  }, [fireCone]);

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


  /* ── Overlay Windy (carte « Wind ») ──────────────────────────────────
     La carte Windy (Leaflet, api.windy.com) est superposée à la carte Mapbox
     et sa caméra est synchronisée (centre + zoom) à chaque move. On retire la
     basemap Windy (pane de tuiles) pour ne garder que les particules de vent.
     Sans clé VITE_WINDY_API_KEY, tout est désactivé (avertissement console).
     NB (docs Windy) : libBoot.js exige Leaflet 1.4.0 chargé AVANT lui (il
     utilise le global `L`) — on injecte donc Leaflet en premier. */
  function loadScriptOnce(src: string, check: () => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      if (check()) {
        resolve();
        return;
      }
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => (check() ? resolve() : reject(new Error(`${src} chargé mais symbole absent`)));
      s.onerror = () => reject(new Error(`Échec du chargement de ${src} (réseau / CSP ?)`));
      document.head.appendChild(s);
    });
  }

  function loadWindyLib(): Promise<void> {
    const st = windyRef.current;
    if (st.lib) return st.lib;
    const w = window as unknown as { windyInit?: unknown; L?: unknown };
    // Leaflet 1.4.0 d'abord (global `L` requis par libBoot.js), puis Windy.
    st.lib = loadScriptOnce(WINDY_LEAFLET_URL, () => typeof w.L !== 'undefined').then(() =>
      loadScriptOnce(WINDY_LIB_URL, () => typeof (window as unknown as { windyInit?: unknown }).windyInit === 'function')
    );
    // Autorise une nouvelle tentative après un échec.
    st.lib.catch(() => {
      st.lib = null;
    });
    return st.lib;
  }

  function syncWindyCamera(map: mapboxgl.Map) {
    const m = windyRef.current.map as unknown as
      | { setView: (latlng: [number, number], zoom: number, o: { animate: boolean }) => void }
      | null
      | undefined;
    if (!m) return;
    try {
      const c = map.getCenter();
      m.setView([c.lat, c.lng], map.getZoom(), { animate: false });
    } catch {
      /* noop */
    }
  }

  /* Active/désactive l'interaction Leaflet côté Windy (drag, zoom molette,
     double-clic, clavier…). En mode météo c'est Windy qui reçoit les gestes. */
  function setWindyInteractive(enabled: boolean) {
    const m = windyRef.current.map as any;
    if (!m) return;
    for (const h of ['dragging', 'touchZoom', 'scrollWheelZoom', 'doubleClickZoom', 'keyboard', 'boxZoom'] as const) {
      try {
        const hh = m?.[h];
        if (hh && typeof hh[enabled ? 'enable' : 'disable'] === 'function') {
          hh[enabled ? 'enable' : 'disable']();
        }
      } catch {
        /* noop */
      }
    }
  }

  /** Mode météo : Windy DEVIENT la carte affichée (avec son propre fond —
   *  l'overlay n'est plus transparent sur Mapbox, donc la météo est enfin
   *  visible) et la scène Mapbox est masquée (plus de double rendu). Mapbox
   *  n'est plus qu'un stock de caméra synchronisé depuis Windy. */
  function enterWeatherMode(map: mapboxgl.Map) {
    const st = windyRef.current;
    if (st.weatherMode) return;
    st.weatherMode = true;
    try {
      map.getContainer().classList.add('windy-active');
    } catch {
      /* noop */
    }
    if (st.el) st.el.style.pointerEvents = 'auto';
    /* Coupe le sync Mapbox→Windy pour éviter une boucle avec le sync inversé. */
    if (st.onMove) {
      try {
        map.off('move', st.onMove);
      } catch {
        /* noop */
      }
      st.onMove = null;
    }
    const m = st.map as any;
    if (m) {
      setWindyInteractive(true);
      if (!st.onWindyMove) {
        st.onWindyMove = () => syncMapboxFromWindy(map);
        try {
          m.on('move', st.onWindyMove);
        } catch {
          /* noop */
        }
      }
    }
  }

  /** Retour au mode normal : Mapbox redevient la carte, Windy est masqué. */
  function exitWeatherMode(map: mapboxgl.Map) {
    const st = windyRef.current;
    if (!st.weatherMode) return;
    st.weatherMode = false;
    try {
      map.getContainer().classList.remove('windy-active');
    } catch {
      /* noop */
    }
    if (st.el) st.el.style.pointerEvents = 'none';
    const m = st.map as any;
    if (m) {
      setWindyInteractive(false);
      if (st.onWindyMove) {
        try {
          m.off('move', st.onWindyMove);
        } catch {
          /* noop */
        }
        st.onWindyMove = null;
      }
    }
    /* Rétablit le sync Mapbox→Windy (Windy redevient overlay masqué). */
    if (!st.onMove) {
      let rafId = 0;
      const onMove = () => {
        if (rafId) return;
        rafId = window.requestAnimationFrame(() => {
          rafId = 0;
          syncWindyCamera(map);
        });
      };
      map.on('move', onMove);
      st.onMove = onMove;
    }
    syncWindyCamera(map);
    // Le canvas Mapbox vient d'être ré-affiché (retiré du display:none) : on
    // force une nouvelle frame pour ne pas rester sur une scène périmée.
    try {
      map.triggerRepaint?.();
    } catch {
      /* noop */
    }
  }

  /** Met à jour la caméra Mapbox depuis Windy (mode météo, sens inversé). */
  function syncMapboxFromWindy(map: mapboxgl.Map) {
    const m = windyRef.current.map as unknown as
      | { getCenter: () => { lng: number; lat: number }; getZoom: () => number }
      | null
      | undefined;
    if (!m) return;
    try {
      const c = m.getCenter();
      const z = m.getZoom();
      if (c && isFinite(c.lng) && isFinite(c.lat) && isFinite(z)) {
        map.setCenter([c.lng, c.lat]);
        map.setZoom(z);
      }
    } catch {
      /* noop */
    }
  }

  /** Affiche (ou initialise puis affiche) l'overlay Windy synchronisé, à
   *  l'heure de prévision `timeIndex` de la timeline. `metric` choisit la
   *  couche Windy : 'wind' (particules) ou temp/pressure/rainfall. */
  async function enableWindyOverlay(map: mapboxgl.Map, timeIndex: number, metric = 'wind') {
    const st = windyRef.current;
    st.seq += 1;
    const seq = st.seq;
    /* `metric` est déjà l'identifiant d'overlay Windy (wind/temperature/
       pressure/rain) — cf. WINDY_OVERLAY dans applyWeatherLayer. */
    const windyOverlay = metric;
    const isParticles = metric === 'wind';
    if (!WINDY_KEY) {
      if (!st.warnedNoKey) {
        st.warnedNoKey = true;
        console.warn(
          '[windy] VITE_WINDY_API_KEY absente — les couches météo Windy sont désactivées. Ajoutez la clé Windy dans le .env racine (frontend, envDir = ..).'
        );
        // Signale l'état sur le conteneur de la carte : le CSS peut afficher
        // un indice (cartes météo sans données tant que la clé est absente).
        try {
          map.getContainer().setAttribute('data-windy-state', 'no-key');
        } catch {
          /* noop */
        }
      }
      return;
    }
    try {
      map.getContainer().setAttribute('data-windy-state', 'on');
    } catch {
      /* noop */
    }
    try {
      await loadWindyLib();
      if (seq !== st.seq) return;
      // Heure cible : `timeIndex` = offset en HEURES depuis maintenant
      // (jour du calendrier × 24 + heure du curseur — cf. FloodConsole).
      // On part de l'heure courante tronquée (pas horaire exact, les
      // prévisions Windy sont des fichiers horaires) et on borne à la
      // fenêtre de prévision (≈ 10 jours / 240 h) pour ne jamais demander
      // un timestamp sans données.
      const nowHour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
      const hourOffset = Math.max(0, Math.min(Math.floor(timeIndex) || 0, 240));
      const startTs = nowHour + hourOffset * 3_600_000;
      // Conteneur transparent superposé à la carte Mapbox (au-dessus du fond,
      // sous les marqueurs/popups qui arrivent plus tard dans le DOM).
      let el = st.el;
      if (!el || !el.isConnected) {
        el = document.createElement('div');
        // Windy libBoot.js récupère le conteneur via document.getElementById('windy')
        // — il ignore l'option `container` passée à windyInit et jette
        // « Missing <div id=\"windy\"></div> » s'il est absent. C'est donc l'id
        // exact « windy » (et pas un nom custom) qu'il faut poser ici.
        el.id = 'windy';
        el.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:3;overflow:hidden;';
        map.getContainer().appendChild(el);
        st.el = el;
      } else {
        el.style.display = 'block';
      }

      if (!st.map) {
        const center = map.getCenter();
        await new Promise<void>((resolve, reject) => {
          const windyInit = (window as unknown as { windyInit?: (o: unknown, cb: (a: unknown) => void) => void })
            .windyInit;
          if (!windyInit) {
            reject(new Error('windyInit indisponible'));
            return;
          }
          windyInit(
            {
              key: WINDY_KEY,
              lat: center.lat,
              lon: center.lng,
              zoom: map.getZoom(),
              container: el,
              timestamp: startTs,
            },
            (api: unknown) => {
              try {
                const a = api as any;
                st.api = api;
                st.map = a?.map ?? null;
                const m = a?.map;
                if (m) {
                  m.dragging?.disable?.();
                  m.touchZoom?.disable?.();
                  m.doubleClickZoom?.disable?.();
                  m.scrollWheelZoom?.disable?.();
                  m.keyboard?.disable?.();
                  m.boxZoom?.disable?.();
                  if (m.zoomControl) {
                    try {
                      m.removeControl(m.zoomControl);
                    } catch {
                      /* noop */
                    }
                  }
                  try {
                    m.getContainer?.()
                      ?.querySelectorAll?.('.leaflet-control-container, .leaflet-top, .leaflet-bottom')
                      .forEach((n: Element) => {
                        (n as HTMLElement).style.display = 'none';
                      });
                  } catch {
                    /* noop */
                  }
                  const mo = m.options ?? {};
                  mo.zoomSnap = 0.1;
                  mo.zoomDelta = 0.1;
                }
                // Couche météo Windy + timestamp calé sur la timeline. Le
                // vent passe en particules animées ; les autres métriques en
                // tuiles colorées. Les particles-mode ne masquent la basemap
                // Windy (pane de tuiles) QUE pour 'wind'.
                try {
                  a?.store?.set?.('overlay', windyOverlay);
                  /* particlesAnim='on' active les particules animées (layer
                     windParticles) ; 'off' affiche le champ coloré. */
                  a?.store?.set?.('particlesAnim', isParticles ? 'on' : 'off');
                  el.classList.toggle('windy-particles-mode', isParticles);
                  a?.store?.set?.('timestamp', startTs);
                } catch {
                  /* noop */
                }
                resolve();
              } catch (e) {
                reject(e);
              }
            }
          );
        });
        if (seq !== st.seq) {
          disableWindyOverlay(map);
          return;
        }
      }

      // Mode météo : Windy devient la carte (fond + météo), Mapbox est masqué
      // et ne fait que suivre la caméra de Windy. Idempotent.
      enterWeatherMode(map);

      // Réactive la couche météo + heure de la timeline + synchronise la
      // caméra et rattache les moves de la carte.
      try {
        (st.api as any)?.store?.set?.('overlay', windyOverlay);
        (st.api as any)?.store?.set?.('particlesAnim', isParticles ? 'on' : 'off');
        st.el?.classList.toggle('windy-particles-mode', isParticles);
        (st.api as any)?.store?.set?.('timestamp', startTs);
      } catch {
        /* noop */
      }
      // Leaflet (Windy) ne gère ni bearing ni pitch : on repasse la carte
      // Mapbox à 0° et on bloque la rotation pendant l'overlay (rétablie à la
      // désactivation).
      try {
        if (st.prevRot == null) {
          st.prevRot = {
            dragRotate: map.dragRotate?.isEnabled?.() ?? false,
            touchPitch: map.touchPitch?.isEnabled?.() ?? false,
          };
        }
        if (map.getBearing() !== 0) map.easeTo({ bearing: 0, duration: 350 });
        map.dragRotate?.disable?.();
        map.touchPitch?.disable?.();
      } catch {
        /* noop */
      }
      if (!st.onMove && !st.weatherMode) {
        /* `move` Mapbox se déclenche plusieurs fois par image : on coalesce
           le setView Leaflet via requestAnimationFrame pour ne synchroniser
           l'overlay qu'une fois par frame (et surtout ne pas relancer un
           re-layout + re-rendu Leaflet à chaque événement move). En mode
           météo (weatherMode) c'est Windy qui pilote — ce listener n'est pas
           posé pour éviter une boucle Mapbox↔Windy. */
        let rafId = 0;
        const onMove = () => {
          if (rafId) return;
          rafId = window.requestAnimationFrame(() => {
            rafId = 0;
            syncWindyCamera(map);
          });
        };
        map.on('move', onMove);
        st.onMove = onMove;
      }
      syncWindyCamera(map);
      const m = st.map as any;
      if (m) {
        try {
          m.invalidateSize?.({ pan: false });
        } catch {
          /* noop */
        }
      }
    } catch (err) {
      // Un 403 Windy n'est presque jamais un bug de code : la clé est verrouillée
      // sur une LISTE DE DOMAINES (API Windy). Un domaine déployé qui n'y figure
      // pas fait échouer `windyInit` avec « Failed to authorize Windy API key »,
      // sans autre indication — on nomme donc le domaine fautif ici.
      const host = typeof window !== 'undefined' ? window.location.hostname : '';
      console.warn(
        `[windy] overlay météo indisponible sur « ${host} ». Si le message ci-dessus ` +
          "est « Failed to authorize Windy API key », ce n'est pas la valeur de la clé " +
          `mais son domaine : ajoutez « ${host} » aux domaines autorisés de la clé ` +
          'dans le tableau de bord Windy.',
        err
      );
      // Propage l'échec (réseau / clé invalide) à l'appelant.
      throw err;
    }
  }

  /** Masque (sans détruire) l'overlay Windy — ex. autre carte météo choisie. */
  function disableWindyOverlay(map: mapboxgl.Map) {
    const st = windyRef.current;
    st.seq += 1;
    // Sort du mode météo d'abord : Mapbox redevient la carte, puis on retire
    // le listener et on masque l'overlay.
    exitWeatherMode(map);
    if (st.onMove) {
      try {
        map.off('move', st.onMove);
      } catch {
        /* noop */
      }
      st.onMove = null;
    }
    try {
      if (st.prevRot?.dragRotate) map.dragRotate?.enable?.();
      if (st.prevRot?.touchPitch) map.touchPitch?.enable?.();
    } catch {
      /* noop */
    }
    st.prevRot = null;
    if (st.el) st.el.style.display = 'none';
  }

  /** Destruction complète (démontage du composant). */
  function disposeWindy() {
    const st = windyRef.current;
    st.seq += 1;
    const m = st.map as any;
    if (st.el && st.el.isConnected) {
      try {
        if (st.onWindyMove && m) m.off('move', st.onWindyMove);
      } catch {
        /* noop */
      }
      try {
        m?.remove?.();
      } catch {
        /* noop */
      }
      st.el.remove();
    }
    st.api = null;
    st.map = null;
    st.el = null;
    st.lib = null;
    st.onMove = null;
    st.onWindyMove = null;
    st.weatherMode = false;
  }

  /** Couche météo active. Tout passe par l'overlay Windy (api.windy.com)
   *  synchronisé sur la carte : « wind » affiche les particules de vent, les
   *  autres métriques basculent l'overlay Windy sur l'overlay correspondant
   *  (température / pression / pluie). `timeIndex` sélectionne l'heure de
   *  prévision. */
  /* Les identifiants d'overlay Windy sont ceux du module `overlays` de
     libBoot.js : wind, temp, pressure, rain… — PAS « temperature ». Passer
     une valeur invalide (ex. « temperature ») fait jeter « Invalid value for
     overlay » et plonge la lib dans une boucle de rendu qui ré-upload sans
     cesse des textures WebGL vides (« Texture has not been initialized…
     This may be slow ») — la cause n°1 du lag météo. */
  const WINDY_OVERLAY: Record<string, string> = {
    wind: 'wind',
    temp: 'temp',
    pressure: 'pressure',
    rainfall: 'rain',
  };
  function applyWeatherLayer(map: mapboxgl.Map, metric: string | undefined, timeIndex: number) {
    if (!metric) {
      disableWindyOverlay(map);
      return;
    }
    void enableWindyOverlay(map, timeIndex, WINDY_OVERLAY[metric] ?? 'wind');
  }

  /* ── Flood Mapping — Vigicrues (tronçons de vigilance crues) ──
     Charge InfoVigiCru.geojson (via le proxy dev /vigicrues) et ajoute une
     couche GeoJSON des tronçons colorés par niveau de vigilance :
       1 = vert (pas de vigilance particulière)
       2 = jaune (risque modéré de crue)
       3 = orange (risque élevé de crue)
       4 = rouge (crue majeure, menace directe)
     La couche est retirée quand le toggle FLOOD MAPPING est désactivé. */
  const VIGICRUES_SOURCE = 'vigicrues-flood';
  const VIGICRUES_LAYER = 'vigicrues-flood-lines';

  function addFloodVigilanceLayer(map: mapboxgl.Map) {
    if (map.getLayer(VIGICRUES_LAYER)) return;
    const addSource = (data: GeoJSON.FeatureCollection) => {
      if (!map.getSource(VIGICRUES_SOURCE)) {
        map.addSource(VIGICRUES_SOURCE, {
          type: 'geojson',
          data,
        });
      }
      if (!map.getLayer(VIGICRUES_LAYER)) {
        map.addLayer({
          id: VIGICRUES_LAYER,
          type: 'line',
          source: VIGICRUES_SOURCE,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': [
              'match',
              ['get', 'NivInfViCr'],
              4,
              '#ff3b30',
              3,
              '#ff9f0a',
              2,
              '#f0c33c',
              1,
              '#2fbf71',
              '#2fbf71',
            ],
            'line-width': 2.6,
            'line-opacity': 0.9,
          },
        });
      }
    };
    fetch('/vigicrues/services/InfoVigiCru.geojson')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(addSource)
      .catch(() => {
        /* Vigicrues indisponible : on retire toute source résiduelle. */
        removeFloodVigilanceLayer(map);
      });
  }

  function removeFloodVigilanceLayer(map: mapboxgl.Map) {
    if (map.getLayer(VIGICRUES_LAYER)) map.removeLayer(VIGICRUES_LAYER);
    if (map.getSource(VIGICRUES_SOURCE)) map.removeSource(VIGICRUES_SOURCE);
  }

  /* ── Enveloppe d'inondation MODÉLISÉE ──
     Un volume d'eau de la hauteur du moteur, dans l'empreinte RÉELLE de
     chaque bâtiment de la vue, plafonné par sa hauteur BDNB. Ce n'est pas
     une surface de crue : c'est la profondeur du modèle (uniforme, au pas de
     5 cm) dessinée à l'échelle du bâti — la même hypothèse que les compteurs
     de dommages. Aucune géométrie n'est écrite : tout passe par les
     propriétés de peinture (littéraux), donc la lecture de la timeline ne
     réécrit jamais la collection GeoJSON. */
  function ensureBuildingsWaterLayer(map: mapboxgl.Map) {
    if (map.getLayer(BUILDINGS_WATER_LAYER)) return;
    if (!map.getSource(BUILDINGS_SOURCE)) return;
    map.addLayer({
      id: BUILDINGS_WATER_LAYER,
      type: 'fill-extrusion',
      source: BUILDINGS_SOURCE,
      layout: { visibility: 'none' },
      paint: {
        'fill-extrusion-height': waterHeightExpr(0),
        'fill-extrusion-base': 0,
        'fill-extrusion-color': '#4fb4e8',
        'fill-extrusion-opacity': 0.85,
      },
    });
  }

  /** Applique l'enveloppe courante : hauteur d'eau, teinte, visibilité.
   *  Aucun `setData` : la profondeur est UNIFORME (hypothèse du modèle), donc
   *  elle s'exprime en littéraux dans l'expression de hauteur. */
  function applyImpact(map: mapboxgl.Map, next: { slabM: number; color: string } | null) {
    ensureBuildingsWaterLayer(map);
    if (!map.getLayer(BUILDINGS_WATER_LAYER)) return;
    const slab = quantiseSlab(next?.slabM ?? 0);
    if (next?.color) {
      map.setPaintProperty(BUILDINGS_WATER_LAYER, 'fill-extrusion-color', next.color);
    }
    if (slab !== impactSlabRef.current) {
      impactSlabRef.current = slab;
      map.setPaintProperty(BUILDINGS_WATER_LAYER, 'fill-extrusion-height', waterHeightExpr(slab));
    }
    map.setLayoutProperty(
      BUILDINGS_WATER_LAYER,
      'visibility',
      next && slab > 0 ? 'visible' : 'none'
    );
  }

  /* L'enveloppe suit l'instant t : la lecture de la timeline fait monter
     l'eau du modèle sans retélécharger le bâti. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current) return;
    /* `null` est un état à part entière : le scénario le plus faible repasse
       SOUS le seuil du moteur, et la couche doit alors disparaître (ne pas
       sortir tôt sur `!impactOn`, sinon l'eau du scénario précédent reste
       peinte sous un compteur qui dit « sous le seuil »). */
    applyImpact(map, impact);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [impactOn, impact?.slabM, impact?.color]);

  /* L'eau se peint dans l'empreinte RÉELLE du bâti : elle exige donc le bâti
     du cadrage courant. On (re)charge la vue dès l'entrée en analyse et dès
     qu'une enveloppe s'ouvre (le bâti de l'étape 1 couvre le cadrage France,
     pas la scène) — sinon la première montée d'eau attendrait un aller-retour
     réseau avant d'apparaître. */
  useEffect(() => {
    if (!riskHighlight && !impactOn) return;
    const map = mapRef.current;
    if (!map || !mapReadyRef.current) return;
    void loadBuildings(map);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [riskHighlight, impactOn]);

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
        const band = bandForResolution(a.resolution);
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
              features: merged.map((f) => ({ ...f, properties: { ...(f.properties || {}), resolution: a.resolution ?? null } })),
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
                  'line-width': 1.8,
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
                  'line-width': 1.4,
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
        if (a.resolution === 'per-building') {
          circle['circle-stroke-color'] = color;
          circle['circle-stroke-width'] = 2;
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

  async function loadBuildings(map: mapboxgl.Map) {
    let west = 0, south = 0, east = 0, north = 0;
    try {
      const bounds = map.getBounds();
      if (!bounds) return; // type v3 : LngLatBounds | null
      west = bounds.getWest(); south = bounds.getSouth(); east = bounds.getEast(); north = bounds.getNorth();
      if (!isFinite(west) || !isFinite(east)) return;
    } catch { return; }
    /* Cache de cadrage : tant que la vue reste DANS l'emprise déjà chargée et
       pour la même adresse, aucun appel réseau (le bâti est déjà là). Sans ce
       garde-fou, chaque fin de déplacement en vue d'analyse relançait un
       téléchargement d'empreintes. */
    const target = currentBatiment()?.batiment_groupe_id ?? null;
    const prev = loadedBboxRef.current;
    if (
      prev &&
      prev.target === target &&
      west >= prev.west && south >= prev.south && east <= prev.east && north <= prev.north
    ) {
      return;
    }
    const seq = ++buildingsSeqRef.current;
    /* Marge de 20 % demandée au serveur : la couverture mémorisée dépasse
       alors la vue, ce qui absorbe les petits déplacements (le cache de
       cadrage ci-dessus évite un aller-retour par micro-pan). */
    const padX = (east - west) * 0.2;
    const padY = (north - south) * 0.2;
    const req = { west: west - padX, south: south - padY, east: east + padX, north: north + padY };
    const url = `${API}/diagnostic/zone/buildings?west=${req.west}&south=${req.south}&east=${req.east}&north=${req.north}&limit=${buildingsLimitRef.current}`;
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
      /* La couverture n'est mémorisée QUE pour un chargement de scène (vue
         d'analyse / 3D) : le chargement « France » du premier écran est trop
         large et trop clairsemé pour servir de couverture à une scène. */
      if (riskHintRef.current || is3dRef.current) {
        loadedBboxRef.current = { ...req, target };
      }
      (map.getSource(BUILDINGS_SOURCE) as mapboxgl.GeoJSONSource)?.setData(fc);
      /* Le bâti vient d'être (re)chargé : l'enveloppe se repose dessus. */
      applyImpact(map, impactRef.current);
    } catch { /* */ }
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

  /* Légende bas-gauche (P4) : bandes D03 réellement affichées sur la carte en
   * ce moment (couches œil actives dans le panneau latéral, présents OU
   * absents — un aléa absent activé montre sa couche communale WMS/WFS et
   * compte donc dans la légende), pas la liste fixe des 5 bandes. */
  const visibleAleas = showRisks && report ? (report.aleas || []).filter((a) => visibleLayerKeys.has(a.code)) : [];
  const activeLegendBands: D03Band[] = RESOLUTION_BANDS.filter((b) => visibleAleas.some((a) => a.resolution === b.key));

  return (
    <div className="mb-demo-wrap">
      {mapError ? (
        <div className="mb-demo-error"><md-icon>error</md-icon><p>{mapError}</p></div>
      ) : (
        <div ref={containerRef} className="mb-demo-map" />
      )}
      {!mapError && !overview && !(points?.length) && activeLegendBands.length > 0 && (
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
      {/* Barre d'outils : ne s'affiche que s'il reste un chip (parcelles ou
         bâtiment cible) — les toggles 3D et éclairage jour/crépuscule ont
         été retirés. */}
      {!mapError && !(points?.length) && (allowParcels || batimentRiskBand(batimentRisques)) && (
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
