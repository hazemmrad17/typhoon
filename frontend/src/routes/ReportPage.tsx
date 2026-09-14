// =============================================================================
//   TYPHOON — /report : page autonome du rapport de risque (étape 3).
//   Page pleine (pas un panneau) : topbar retour/export, bandeau d'identité
//   façon Géorisques, mini-carte de la zone (marqueur + empreinte BDNB),
//   graphiques (trajectoire pluie prévue), repères de géographie réelle,
//   recommandations documentaires, confiance, annexe, mention Géorisques. Le rapport est streamé (SSE) depuis le
//   backend ; l'export PDF se fait via l'impression du navigateur (feuille
//   de style print).
// =============================================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import mapboxgl from 'mapbox-gl';
import {
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Area,
  AreaChart,
} from 'recharts';
import type { RisqueReport, AleaDetail } from '../zone/config';
import { exposureClass, exposureOf } from '../zone/exposure';
import {
  scenarioFor,
} from '../zone/damageModel';
import {
  fetchFloodAlea,
  triDepthForScenario,
  bandPeakM,
  type FloodAleaResult,
} from '../zone/floodAlea';
import {
  buildJourney,
  fetchHydroRoute,
  fetchMeteo,
  fmtHours,
  fmtKm,
  type HydroRoute,
  type Journey,
  type MeteoData,
} from '../zone/hydroRoute';
import { clearJourney, mountJourney } from '../zone/hydroLayer';
import {
  useReportStream,
  type ReportPayload,
} from '../zone/useReportStream';
import { loadCache } from '../zone/diagnosticCache';
import { geomToWgs84, firstRing } from '../zone/mapHelpers';
import '../styles/report.css';

const MAPBOX_TOKEN: string = (import.meta as any).env?.VITE_MAPBOX_TOKEN || '';
if (MAPBOX_TOKEN) mapboxgl.accessToken = MAPBOX_TOKEN;

interface ZoneState {
  place: string | null;
  report: RisqueReport | null;
  scenarioKey: string;
  timeMin: number;
  /** Trajet de l'eau reconstruit à l'étape 2 (géographie réelle) — absent au
      rechargement, auquel cas la page le reconstruit elle-même. */
  hydro?: HydroRoute | null;
}

/* SCN-001 — les clés UI sont les clés TRI : 'extreme' (et non l'ancien
   alias 'direct', qui ne résolvait aucune classe). */
const DEFAULTS = { scenarioKey: 'extreme', timeMin: 195 };

/** Résumé de GÉOGRAPHIE RÉELLE transmis au backend (aucune valeur simulée).
 *  `null` quand aucun trajet n'est reconstituable → le rapport reste alors
 *  exactement celui d'avant (la clé de cache ne change pas côté serveur). */
function hydroSummary(hydro: HydroRoute | null): ReportPayload['hydro'] {
  if (!hydro || hydro.unavailable_reason) return null;
  return {
    watercourse: hydro.watercourse ?? null,
    snap_distance_m: hydro.snap_distance_m ?? null,
    basin: hydro.basin
      ? {
          libelle: hydro.basin.libelle ?? null,
          toponyme: hydro.basin.toponyme ?? null,
          group_libelle: hydro.basin.group_libelle ?? null,
          area_km2: hydro.basin.area_km2 ?? null,
        }
      : null,
    upstream_km: hydro.upstream?.length_km ?? 0,
    downstream_km: hydro.downstream?.length_km ?? 0,
    upstream_stop: hydro.upstream?.stop.reason ?? null,
    downstream_stop: hydro.downstream?.stop.reason ?? null,
    arrival_min_hours: hydro.arrival?.min_hours ?? null,
    arrival_max_hours: hydro.arrival?.max_hours ?? null,
    sources: hydro.sources,
  };
}

function categoryIcon(category: string): string {
  if (category === 'structural') return 'location_city';
  if (category === 'power') return 'bolt';
  if (category === 'road') return 'road';
  if (category === 'conduit') return 'water_damage';
  if (category === 'vegetation') return 'park';
  return 'shield';
}

function cap(s: string | null | undefined): string | null {
  if (!s) return null;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ── Mini-carte de la zone : marqueur du bien + empreinte BDNB + aléas de la
   commune en surimpression (couches vectorielles réelles). ── */
function MiniRiskMap({ report }: { report: RisqueReport | null }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);

  useEffect(() => {
    if (!ref.current || !report || report.lat == null || report.lon == null) return;
    if (!MAPBOX_TOKEN) return;
    const map = new mapboxgl.Map({
      container: ref.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: [report.lon, report.lat],
      zoom: 15,
      interactive: true,
      attributionControl: false,
    });
    mapRef.current = map;

    map.on('load', () => {
      // Marqueur de la zone diagnostiquée.
      new mapboxgl.Marker({ color: '#ff3b30' })
        .setLngLat([report.lon, report.lat])
        .addTo(map);

      // Empreinte BDNB (EPSG:2154 → WGS84) si disponible.
      const wgs = geomToWgs84(report.bdnb?.batiment?.geom_groupe as Record<string, unknown> | undefined);
      const ring = wgs ? firstRing(wgs.coordinates) : null;
      if (ring && ring.length >= 3) {
        map.addSource('bdnb', {
          type: 'geojson',
          data: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} },
        });
        map.addLayer({ id: 'bdnb-fill', type: 'fill', source: 'bdnb', paint: { 'fill-color': '#ff3b30', 'fill-opacity': 0.25 } });
        map.addLayer({ id: 'bdnb-line', type: 'line', source: 'bdnb', paint: { 'line-color': '#ff3b30', 'line-width': 2 } });
        const xs = ring.map((p) => p[0]);
        const ys = ring.map((p) => p[1]);
        map.fitBounds(
          [
            [Math.min(...xs), Math.min(...ys)],
            [Math.max(...xs), Math.max(...ys)],
          ],
          { padding: 48, maxZoom: 17 }
        );
      }
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [report]);

  return <div className="rp-map" ref={ref} />;
}

/* ── Carte du trajet de l'eau : GÉOGRAPHIE RÉELLE (réseau hydrographique IGN
   BD TOPO). Mêmes couches et même vol que la carte de l'application (modules
   partagés hydroLayer / waterFlight) → le rapport montre exactement le tracé
   reconstruit à l'étape 2, sans recharge de données. ── */
/* Le trajet est montré en PLAN, statiquement : un rapport se lit et s'imprime.
   La lecture animée du parcours (WaterFlight) vit à l'étape 2, où elle a une
   raison d'être interactive ; la rejouer ici n'ajoutait aucune information et
   introduisait des commandes d'interface dans un document destiné au papier. */
function JourneyMap({
  report,
  journey,
  basinGeometry,
}: {
  report: RisqueReport | null;
  journey: Journey;
  basinGeometry: GeoJSON.Geometry | null;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);

  useEffect(() => {
    if (!ref.current || !report || report.lat == null || report.lon == null) return;
    if (!MAPBOX_TOKEN) return;
    const map = new mapboxgl.Map({
      container: ref.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: [report.lon, report.lat],
      zoom: 14,
      pitch: 45,
      interactive: true,
      attributionControl: false,
      /* Le canvas WebGL doit rester lisible par l'impression : sans ce
         drapeau, window.print() produit une carte blanche dans le PDF. */
      preserveDrawingBuffer: true,
    });
    mapRef.current = map;

    map.on('load', () => {
      new mapboxgl.Marker({ color: '#ff3b30' })
        .setLngLat([report.lon, report.lat])
        .addTo(map);

      mountJourney(map, journey, { lon: report.lon, lat: report.lat }, basinGeometry);

      /* Cadrage sur le tracé réel reconstruit (pas une emprise arbitraire). */
      const coords = journey.coords;
      const xs = coords.map((c) => c[0]);
      const ys = coords.map((c) => c[1]);
      if (xs.length >= 2) {
        map.fitBounds(
          [
            [Math.min(...xs), Math.min(...ys)],
            [Math.max(...xs), Math.max(...ys)],
          ],
          { padding: 48, maxZoom: 13 }
        );
      }
      const wgs = geomToWgs84(report.bdnb?.batiment?.geom_groupe as Record<string, unknown> | undefined);
      const ring = wgs ? firstRing(wgs.coordinates) : null;
      if (ring && ring.length >= 3) {
        map.addSource('bdnb', {
          type: 'geojson',
          data: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} },
        });
        map.addLayer({ id: 'bdnb-fill', type: 'fill', source: 'bdnb', paint: { 'fill-color': '#ff3b30', 'fill-opacity': 0.25 } });
      }
    });

    return () => {
      clearJourney(map);
      map.remove();
      mapRef.current = null;
    };
  }, [report, journey, basinGeometry]);

  return <div className="rp-map" ref={ref} />;
}

/** Pluie PRÉVUE réelle (Open-Meteo) — jamais un profil inventé. Si la
 *  prévision est indisponible, on ne dessine aucune courbe : une courbe plate
 *  laisserait croire à un événement sans pluie mesurée. */
function rainChartData(meteo: MeteoData | null): { hour: string; rain: number }[] {
  if (!meteo || meteo.rain_hourly.length === 0) return [];
  return meteo.rain_hourly.map((p) => ({
    hour: p.t.length >= 16 ? p.t.slice(11, 16) : p.t,
    rain: typeof p.v === 'number' ? p.v : 0,
  }));
}

export function ReportPage({
  initialState = null,
  onClose = null,
}: {
  /* État transmis directement par la vue /zone (mode panneau intégré) —
     absent sur la route /report autonome (état de navigation ou cache). */
  initialState?: ZoneState | null;
  /* Fermeture du panneau (retour à la carte sans quitter /zone). null sur la
     route autonome → le bouton retour navigue vers /zone. */
  onClose?: (() => void) | null;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const state = (location.state ?? {}) as ZoneState;

  /* Si on arrive sans état (rechargement), on retombe sur le diagnostic le
     plus récent du cache local. En mode panneau, l'état vient du parent. */
  const initial = useMemo((): ZoneState => {
    const fromProps = initialState?.report ? initialState : null;
    const fromNav = state.report ? state : null;
    const src = fromProps ?? fromNav;
    if (src) {
      return {
        place: src.place,
        report: src.report,
        scenarioKey: src.scenarioKey ?? DEFAULTS.scenarioKey,
        timeMin: src.timeMin ?? DEFAULTS.timeMin,
      };
    }
    const entries = loadCache();
    const latest = entries[0] ?? null;
    return {
      place: latest ? latest.report.adresse_normalisee : null,
      report: latest ? latest.report : null,
      scenarioKey: DEFAULTS.scenarioKey,
      timeMin: DEFAULTS.timeMin,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [place] = useState<string | null>(initial.place);
  const [report] = useState<RisqueReport | null>(initial.report);
  const [scenarioKey] = useState<string>(initial.scenarioKey);
  const [timeMin] = useState<number>(initial.timeMin);

  /* ── Trajet de l'eau (GÉOGRAPHIE RÉELLE) ──
     Le parcours vient de l'étape 2 ; si la page est rechargée directement, il
     est reconstruit ici par le même contrat. La référence météo/hydrologique
     RÉELLE (pluie prévue Open-Meteo, débit estimé GloFAS) est chargée à part :
     elle est AFFICHÉE À CÔTÉ de l'enveloppe de scénario, jamais fondue dedans. */
  const [hydro, setHydro] = useState<HydroRoute | null>(initial.hydro ?? null);
  const [hydroLoading, setHydroLoading] = useState(false);
  /* Plus d'état de prolongation : le rapport ne pilote plus la reconstruction
     (« Prolonger le parcours » était une commande d'interface sans effet sur
     un document imprimé). Les longueurs et les arrêts RÉELS restent affichés. */
  const [meteo, setMeteo] = useState<MeteoData | null>(null);
  /* Repère réglementaire TRI (Directive Inondation) — même calage du pic d'eau
     que l'étape 2. Hors TRI ou service indisponible : null → enveloppe pure. */
  const [floodAlea, setFloodAlea] = useState<FloodAleaResult | null>(null);


  const journey = useMemo(() => (hydro ? buildJourney(hydro) : null), [hydro]);
  const basinGeometry = hydro?.basin?.geometry ?? null;

  useEffect(() => {
    if (!report) return;
    const ctrl = new AbortController();
    if (!initial.hydro) {
      setHydroLoading(true);
      fetchHydroRoute(report.lat, report.lon, undefined, ctrl.signal)
        .then((res) => {
          if (!ctrl.signal.aborted) setHydro(res);
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setHydroLoading(false);
        });
    }
    fetchMeteo(report.lat, report.lon, ctrl.signal).then((m) => {
      if (!ctrl.signal.aborted) setMeteo(m);
    });
    fetchFloodAlea(report.lat, report.lon, ctrl.signal).then((res) => {
      if (!ctrl.signal.aborted) setFloodAlea(res);
    });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report]);

  /* Instant t = même source que l'écran /zone. Plus aucun montant de dommage
     n'en est dérivé : les estimations synthétiques ont été supprimées. */
  const scenario = scenarioFor(scenarioKey);
  const selectedTri = useMemo(() => triDepthForScenario(floodAlea, scenarioKey), [floodAlea, scenarioKey]);
  const triPeak = selectedTri ? bandPeakM(selectedTri.depth_band!) : null;

  const payload: ReportPayload | null = useMemo(() => {
    if (!report) return null;
    const now = new Date();
    const hh = String(Math.floor(timeMin / 60)).padStart(2, '0');
    const mm = String(timeMin % 60).padStart(2, '0');
    return {
      sector: place ?? report.adresse_normalisee ?? 'Secteur',
      timestamp: `${now.toISOString().slice(0, 10)}T${hh}:${mm}:00`,
      scenario: {
        key: scenario.key,
        risk: scenario.risk,
        depthPeakM: triPeak ?? 0,
        /* Sans classe au point, le rapport doit pouvoir distinguer « dans un
           TRI sans classe à cet emplacement » (un quai) de « hors TRI » —
           `floodAlea === null` = appartenance non vérifiée, jamais "hors". */
        inTri: floodAlea ? floodAlea.in_tri : null,
      },
      /* Trajet de l'eau RÉEL : un résumé de géographie, aucune valeur simulée.
         Absent → rapport inchangé (la clé de cache côté serveur ne bouge pas). */
      hydro: hydroSummary(hydro),
    };
  }, [report, place, scenario, timeMin, hydro, triPeak, floodAlea]);

  const stream = useReportStream(payload);

  /* Faits RÉELS affichés à côté de l'enveloppe : pluie prévue et débit estimé. */
  const rainData = useMemo(() => rainChartData(meteo), [meteo]);
  const profileData = useMemo(
    () => (journey?.profile ?? []).map((p) => ({ km: p.km.toFixed(1), z: p.z_m })),
    [journey]
  );

  /* Faits du trajet RÉEL (géographie) — chaque ligne est une donnée sourcée. */
  const journeyRows: [string, string][] = useMemo(() => {
    if (!hydro || hydro.unavailable_reason) return [];
    return [
      ['Cours d’eau', hydro.watercourse ?? 'sans toponyme (tronçon sans nom dans BD TOPO)'],
      [
        'Accrochage de l’adresse',
        hydro.snap_distance_m != null
          ? `${Math.round(hydro.snap_distance_m)} m du tracé réel`
          : '—',
      ],
      [
        'Bassin versant local',
        `${hydro.basin?.toponyme ?? 'sans toponyme'}${
          hydro.basin?.area_km2 ? ` · ${Math.round(hydro.basin.area_km2)} km²` : ''
        }`,
      ],
      ['Rattachement hydrographique', hydro.basin?.group_libelle ?? '—'],
      [
        'Cours d’eau reconstruit en amont',
        `${fmtKm(journey?.upstreamKm ?? 0)} — arrêt : ${hydro.upstream?.stop.label ?? '—'}`,
      ],
      [
        'Cours d’eau reconstruit en aval',
        `${fmtKm(journey?.downstreamKm ?? 0)} — arrêt : ${hydro.downstream?.stop.label ?? '—'}`,
      ],
      [
        'Propagation depuis l’amont reconstruit',
        hydro.arrival
          ? `${fmtHours(hydro.arrival.min_hours)} – ${fmtHours(hydro.arrival.max_hours)} (bande de célérité ${hydro.arrival.celerity_min_m_s}–${hydro.arrival.celerity_max_m_s} m/s)`
          : '—',
      ],
    ];
  }, [hydro, journey]);

  /* ── Synthèse DÉTERMINISTE (façon Géorisques) — dérivée de report.aleas.
     Aucune intervention du LLM : le comptage et les statuts viennent des
     faits Géorisques déjà normalisés par le diagnostic. */
  const NAT_ALEAS = [
    'inondation', 'mouvement_terrain', 'rga', 'sismicite', 'feu_foret',
    'radon', 'cavite', 'avalanche',
  ] as const;
  const TECH_ALEAS = ['icpe', 'canalisations', 'ssp', 'ppr'] as const;

  const aleaByCode = useMemo(() => {
    const map: Record<string, AleaDetail> = {};
    for (const a of report?.aleas ?? []) map[a.code] = a;
    return map;
  }, [report]);

  const synthese = useMemo(() => {
    const count = (codes: readonly string[]) =>
      codes.filter((c) => {
        const a = aleaByCode[c];
        return a && (a.present === true || a.present_commune === true);
      }).length;
    return { natCount: count(NAT_ALEAS), techCount: count(TECH_ALEAS) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aleaByCode]);

  /* Fiches de détail : les aléas RÉELLEMENT identifiés (adresse ou commune).
     Le libellé d'exposition est dérivé de la RÉSOLUTION (cf. zone/exposure) :
     plus de « à mon adresse » collé sur une estimation communale. */
  const detailAleas = useMemo(
    () =>
      (report?.aleas ?? [])
        .map((a) => ({ alea: a, expo: exposureOf(a) }))
        .filter(({ expo }) => expo.identified),
    [report]
  );

  /* Aléas listés dans la synthèse : uniquement ceux identifiés. Afficher huit
     lignes « non recensé » noie l'information — Géorisques ne liste que ce qui
     existe, et le comptage en tête porte déjà le reste. */
  const identifiedByGroup = useMemo(() => {
    const pick = (codes: readonly string[]) =>
      codes
        .map((c) => aleaByCode[c])
        .filter((a): a is AleaDetail => !!a)
        .map((a) => ({ alea: a, expo: exposureOf(a) }))
        .filter(({ expo }) => expo.identified);
    return { naturals: pick(NAT_ALEAS), techno: pick(TECH_ALEAS) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aleaByCode]);

  /* Historique CatNat aplati (aléa, date, libellé) — max 40 lignes. */
  const catnatRows = useMemo(() => {
    const rows: Array<[string, string, string]> = [];
    for (const a of report?.aleas ?? []) {
      for (const ev of a.catnat_historique ?? []) {
        rows.push([
          a.code,
          ev.date_debut_evt ?? '—',
          ev.libelle_risque_jo ?? ev.libelle ?? '—',
        ]);
      }
    }
    return rows.slice(0, 40);
  }, [report]);

  /* ── FAITS CLÉS — la seule « interprétation » autorisée : un ORDRE DE
     LECTURE des faits sourcés (§2 interdit tout score, toute note, toute
     recommandation). Chaque ligne est une valeur du diagnostic, jamais un
     jugement. Objectif : qu'un lecteur (assureur, notaire, propriétaire)
     trouve en une page ce qui décide, au lieu de le chercher dans dix
     sections. */
  const bdnbBat = report?.bdnb?.batiment ?? null;
  const keyFacts = useMemo(() => {
    const rows: Array<[string, string, string]> = [];
    if (!report) return rows;

    /* 1. Exposition inondation — classe RÉGLEMENTAIRE, ou son absence. */
    rows.push(
      selectedTri
        ? [
            'Exposition inondation (TRI)',
            `Classe ${selectedTri.depth_band?.label ?? '—'} (${selectedTri.label})`,
            selectedTri.cours_deau ?? '—',
          ]
        : [
            'Exposition inondation (TRI)',
            'Aucune classe de hauteur cartographiée au point',
            'Hors TRI n’est pas « jamais inondé »',
          ]
    );

    /* 2. CatNat — le fait le plus utilisé par un assureur. On ÉCRIT l'absence
       au lieu d'omettre la ligne : « aucun arrêté recensé » est une donnée. */
    rows.push([
      'Arrêtés CatNat (commune)',
      catnatRows.length > 0 ? `${catnatRows.length} recensé(s)` : 'Aucun recensé',
      'GASPAR / Géorisques',
    ]);

    /* 3. Distance au cours d'eau identifié + fenêtre de propagation : c'est ce
       qui dit COMBIEN DE TEMPS on a, ce qu'aucun zonage ne donne. */
    if (hydro && !hydro.unavailable_reason) {
      rows.push([
        'Cours d’eau le plus proche',
        hydro.watercourse ?? '—',
        hydro.snap_distance_m != null
          ? `accrochage à ${Math.round(hydro.snap_distance_m)} m de l’adresse`
          : 'distance non mesurée',
      ]);
      if (hydro.basin?.area_km2 != null) {
        rows.push([
          'Bassin versant contributeur',
          `${Math.round(hydro.basin.area_km2)} km²`,
          hydro.basin.toponyme ?? hydro.basin.libelle ?? 'BD TOPO',
        ]);
      }
      if (hydro.arrival) {
        rows.push([
          'Délai de propagation depuis l’amont',
          `${fmtHours(hydro.arrival.min_hours)} – ${fmtHours(hydro.arrival.max_hours)}`,
          `bande de célérité ${hydro.arrival.celerity_min_m_s}–${hydro.arrival.celerity_max_m_s} m/s`,
        ]);
      }
    }

    /* 4. Bâtiment — facteurs de vulnérabilité RÉELS (BDNB), pas une note. */
    if (bdnbBat) {
      const b = bdnbBat as Record<string, unknown>;
      const year = typeof b.annee_construction === 'number' ? String(b.annee_construction) : null;
      const h = typeof b.hauteur_mean === 'number' ? `${(b.hauteur_mean as number).toFixed(1)} m` : null;
      rows.push([
        'Bâtiment (BDNB)',
        [year, h].filter(Boolean).join(' · ') || '—',
        [cap(b.mat_mur_txt as string), cap(b.mat_toit_txt as string)].filter(Boolean).join(' / ') || '—',
      ]);
    }

    /* 5. Séisme — zone nationale + accélération de référence du décret. */
    const seis = aleaByCode['sismicite'];
    if (seis && seis.present === true) {
      rows.push([
        'Zone sismique (décret 2010-1255)',
        seis.zone_sismique ?? 'zone non précisée',
        'échelle communale (zonage national)',
      ]);
    }

    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report, selectedTri, catnatRows.length, hydro, aleaByCode, bdnbBat]);

  const exportPdf = () => {
    window.print();
  };

  if (!report) {
    return (
      <div className="rp-page">
        <div className="rp-topbar">
          <button
            className="rp-back"
            onClick={() => (onClose ? onClose() : navigate('/zone'))}
          >
            <md-icon aria-hidden="true">arrow_back</md-icon>
            <span>Retour</span>
          </button>
          <span className="rp-brand">Rapport de risque</span>
        </div>
        <div className="rp-empty">
          <md-icon aria-hidden="true">description</md-icon>
          <span>
            Aucun diagnostic disponible. Lancez d'abord un diagnostic d'adresse depuis la carte.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="rp-page">
      {/* ── Barre supérieure : retour + export ── */}
      <header className="rp-topbar">
        <button
          className="rp-back"
          onClick={() => (onClose ? onClose() : navigate('/zone'))}
        >
          <md-icon aria-hidden="true">arrow_back</md-icon>
          <span>{onClose ? 'Retour à la carte' : 'Retour à la carte'}</span>
        </button>
        <span className="rp-brand">Rapport de risque</span>
        <button className="rp-export" onClick={exportPdf} title="Exporter en PDF (impression)">
          <md-icon aria-hidden="true">download</md-icon>
          <span>Exporter / PDF</span>
        </button>
      </header>

      <div className="rp-scroll">
        <div className="rp-doc">
          {/* ── Bandeau d'identité façon Géorisques ── */}
          {stream.header ? (
            <section className="rp-ident">
              <div className="rp-ident-brand">
                <span className="rp-ident-logo">Géorisques</span>
                <span className="rp-ident-mention">Rapport d'analyse des risques d'un bien</span>
              </div>
              <div className="rp-ident-grid">
                <div className="rp-ident-cell">
                  <span className="rp-ident-label">Secteur</span>
                  <span className="rp-ident-val">{stream.header.sector}</span>
                </div>
                <div className="rp-ident-cell">
                  <span className="rp-ident-label">Scénario</span>
                  <span className="rp-ident-val">{stream.header.scenario}</span>
                </div>
                <div className="rp-ident-cell">
                  <span className="rp-ident-label">Évaluation</span>
                  <span className="rp-ident-val">{stream.header.timestamp_label}</span>
                </div>
              </div>
            </section>
          ) : null}

          {stream.status === 'loading' || stream.status === 'streaming' ? (
            <div className="rp-streaming" role="status">
              <span className="rp-spinner" aria-hidden="true" />
              <span>
                {stream.status === 'loading' ? 'Connexion au service…' : 'Génération du rapport en cours…'}
              </span>
            </div>
          ) : null}

          {stream.status === 'error' ? (
            <div className="rp-error" role="alert">
              <md-icon aria-hidden="true">error</md-icon>
              <span>
                Impossible de générer le rapport ({stream.error}). Vérifiez que le backend est démarré sur le port 8000.
              </span>
            </div>
          ) : null}

          {stream.fallback ? (
            <div className="rp-fallback">
              <md-icon aria-hidden="true">info</md-icon>
              <span>
                Prose IA indisponible — rapport rendu en mode template. Les nombres et recommandations restent calculés à partir des données du secteur.
              </span>
            </div>
          ) : null}

          {/* ── FAITS CLÉS — ordre de lecture des faits sourcés (aucun score,
              aucune recommandation : constitution §2). Chaque valeur est celle
              du diagnostic, avec son échelle réelle. ── */}
          {keyFacts.length > 0 ? (
            <section className="rp-block rp-keyfacts">
              <h2 className="rp-h2">Faits clés</h2>
              <ul className="rp-facts">
                {keyFacts.map(([label, value, note]) => (
                  <li className="rp-fact" key={label}>
                    <span className="rp-fact-label">{label}</span>
                    <span className="rp-fact-value">{value}</span>
                    {note ? <span className="rp-fact-note">{note}</span> : null}
                  </li>
                ))}
              </ul>
              <p className="rp-foot-note">
                Ces valeurs sont des faits sourcés, avec l’échelle de leur source —
                aucun indice composite, aucune appréciation n’y est ajoutée.
              </p>
            </section>
          ) : null}

          {/* ── SYNTHÈSE DÉTERMINISTE (façon Géorisques) ──
              Comptage réel depuis report.aleas : « X risques naturels / Y
              risques technologiques identifiés », avec le statut par aléa —
              à mon adresse (present) / sur ma commune (present_commune) /
              non recensé. AUCUNE prose IA : les seules phrases sont des
              gabarits à trous remplis par les données. */}
          {synthese ? (
            <section className="rp-block">
              <h2 className="rp-h2">Synthèse des risques</h2>
              <p className="rp-summary-text">
                Pour <b>{report.adresse_normalisee}</b>, {synthese.natCount}{' '}
                risque(s) naturel(s) et {synthese.techCount} risque(s)
                technologique(s) sont identifiés au moins au niveau communal.
              </p>
              <div className="rp-alea-groups">
                <div className="rp-alea-group">
                  <h3 className="rp-alea-group-title">
                    {synthese.natCount} Risque(s) naturel(s) identifié(s)
                  </h3>
                  <ul className="rp-alea-grid">
                    {identifiedByGroup.naturals.map(({ alea, expo }) => (
                      <li key={alea.code} className={`rp-alea-cell ${exposureClass(expo.level)}`}>
                        <span className="rp-alea-name">{alea.libelle}</span>
                        <span className="rp-alea-status">{expo.label}</span>
                        <span className="rp-alea-res">{expo.resolutionLabel}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="rp-alea-group">
                  <h3 className="rp-alea-group-title">
                    {synthese.techCount} Risque(s) technologique(s) identifié(s)
                  </h3>
                  <ul className="rp-alea-grid">
                    {identifiedByGroup.techno.map(({ alea, expo }) => (
                      <li key={alea.code} className={`rp-alea-cell ${exposureClass(expo.level)}`}>
                        <span className="rp-alea-name">{alea.libelle}</span>
                        <span className="rp-alea-status">{expo.label}</span>
                        <span className="rp-alea-res">{expo.resolutionLabel}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </section>
          ) : null}

          {/* ── DÉTAIL PAR ALÉA (données Géorisques, zéro invention) ──
              Une fiche par aléa IDENTIFIÉ (present ou present_commune) :
              statut, zonage verbatim, résolution, historique CatNat. */}
          {detailAleas.length > 0 ? (
            <section className="rp-block">
              <h2 className="rp-h2">Détail des risques identifiés</h2>
              <div className="rp-cats">
                {detailAleas.map(({ alea, expo }) => (
                  <div className="rp-catcard" key={alea.code}>
                    <div className="rp-catcard-head">
                      <md-icon aria-hidden="true">{categoryIcon(alea.code)}</md-icon>
                      <span className="rp-catcard-label">{alea.libelle}</span>
                      <span
                        className={`rp-badge rp-badge--${expo.level === 'adresse' ? 'eleve' : 'modere'}`}
                        title={`Échelle de la donnée : ${expo.resolutionLabel}`}
                      >
                        {expo.label}
                      </span>
                    </div>
                    <p className="rp-catcard-text">
                      {alea.zonage ?? 'Statut communal sans zonage détaillé.'}
                    </p>
                    {/* L'échelle est TOUJOURS affichée : c'est elle qui borne la
                        portée du fait (« zonage sismique national », « testé au
                        bâtiment »…). */}
                    <p className="rp-catcard-res">Échelle : {expo.resolutionLabel}</p>
                    {alea.url_detail ? (
                      <p className="rp-catcard-res">
                        Source : <span className="rp-catcard-src">{alea.source ?? 'Géorisques'}</span>
                      </p>
                    ) : null}
                    {alea.erreur ? (
                      <p className="rp-catcard-res">
                        Source indisponible : {alea.erreur}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {/* ── HISTORIQUE CatNat (arrêtés GASPAR) — TOUJOURS rendu : l'absence
              d'arrêté est une information, pas une section à masquer. ── */}
          <section className="rp-block">
            <h2 className="rp-h2">Historique CatNat (arrêtés préfectoraux)</h2>
            {catnatRows.length === 0 ? (
              <p className="rp-confidence">
                Aucun arrêté de catastrophe naturelle recensé pour cette commune dans la
                base GASPAR exposée par Géorisques, à la date d’évaluation du rapport.
              </p>
            ) : (
              <table className="rp-table">
                <thead>
                  <tr>
                    <th>Aléa</th>
                    <th>Début de l&apos;événement</th>
                    <th>Libellé (JO)</th>
                  </tr>
                </thead>
                <tbody>
                {catnatRows.map(([code, date, label], i) => (
                  <tr key={`${code}-${date}-${i}`}>
                    <td>{aleaByCode[code]?.libelle ?? code}</td>
                    <td>{date}</td>
                    <td>{label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            )}
          </section>

          {/* ── Localisation + carte (si token Mapbox) ── */}
          <section className="rp-block">
            <h2 className="rp-h2">Localisation de la zone</h2>
            <div className="rp-map-wrap">
              {MAPBOX_TOKEN ? (
                <MiniRiskMap report={report} />
              ) : (
                <div className="rp-map-fallback">
                  <md-icon aria-hidden="true">map</md-icon>
                  <span>
                    {report.adresse_normalisee}
                    {report.lat != null && report.lon != null
                      ? ` · ${report.lat.toFixed(5)}, ${report.lon.toFixed(5)}`
                      : ''}
                  </span>
                </div>
              )}
              <div className="rp-map-legend">
                <span className="rp-legend-dot" /> Empreinte BDNB · marqueur : bien diagnostiqué
              </div>
            </div>
          </section>

          {/* ── Trajet de l'eau (GÉOGRAPHIE RÉELLE) — pleine largeur ──
              Remplace l'ancienne « simulation » à curseur de hauteur d'eau, qui
              projetait un niveau arbitraire sur un zonage souvent inexistant.
              Ici le cours d'eau qui draine l'adresse est réellement identifié
              sur le réseau IGN BD TOPO, parcouru en amont et en aval, et le vol
              suit le tracé réel. La référence météo/hydrologique réelle est
              affichée À CÔTÉ de l'enveloppe de scénario, jamais fusionnée. ── */}
          <section className="rp-block rp-hydro">
            <h2 className="rp-h2">
              Trajet de l&apos;eau
              <span className="rp-hydro-flag">réel · IGN BD TOPO</span>
            </h2>

            {hydroLoading ? (
              <span className="rp-sim-note">Reconstruction du parcours sur le réseau réel…</span>
            ) : hydro && hydro.unavailable_reason ? (
              <span className="rp-sim-note">{hydro.unavailable_label}</span>
            ) : null}

            {journey ? (
              <>
                <div className="rp-hydro-grid">
                  <div className="rp-hydro-map">
                    {MAPBOX_TOKEN ? (
                      <JourneyMap
                        report={report}
                        journey={journey}
                        basinGeometry={basinGeometry}
                      />
                    ) : (
                      <div className="rp-map-fallback">
                        <md-icon aria-hidden="true">map</md-icon>
                        <span>Carte indisponible (jeton Mapbox absent).</span>
                      </div>
                    )}
                    <div className="rp-map-legend">
                      <span className="rp-legend-dot rp-legend-dot--water" />
                      Tracé réel du cours d&apos;eau, bassin versant contributeur et extrémités
                      (IGN BD TOPO)
                    </div>
                  </div>

                  {/* ── Colonne latérale STATIQUE ──
                      Un rapport se lit et s'imprime : la lecture animée du
                      trajet, le curseur de position et les boutons
                      « prolonger » étaient des commandes d'interface qui ne
                      produisaient rien sur papier et détournaient du contenu.
                      Le parcours est ici donné comme FAIT (longueurs, arrêts de
                      reconstruction), pas comme une démo à piloter. */}
                  <div className="rp-hydro-side">
                    <ul className="rp-facts rp-facts--compact">
                      <li className="rp-fact">
                        <span className="rp-fact-label">Parcours reconstruit (amont / aval)</span>
                        <span className="rp-fact-value">
                          {fmtKm(journey.upstreamKm)} / {fmtKm(journey.downstreamKm)}
                        </span>
                        <span className="rp-fact-note">
                          total {fmtKm(journey.totalKm)} · réseau IGN BD TOPO
                        </span>
                      </li>
                      <li className="rp-fact">
                        <span className="rp-fact-label">Arrêt de reconstruction</span>
                        <span className="rp-fact-value">
                          {hydro?.upstream?.stop.label ?? '—'}
                        </span>
                        <span className="rp-fact-note">
                          amont · aval : {hydro?.downstream?.stop.label ?? '—'}
                        </span>
                      </li>
                    </ul>

                    <div className="rp-sim-chart">
                      <span className="rp-chart-title">
                        Profil en long réel du cours d&apos;eau (altitude BD TOPO)
                      </span>
                      {profileData.length >= 2 ? (
                        <ResponsiveContainer width="100%" height={150}>
                          <AreaChart
                            data={profileData}
                            margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
                          >
                            <defs>
                              <linearGradient id="zGrad" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor="#4d86c4" stopOpacity={0.5} />
                                <stop offset="100%" stopColor="#4d86c4" stopOpacity={0.02} />
                              </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                            <XAxis
                              dataKey="km"
                              stroke="var(--rp-muted)"
                              fontSize={9}
                              tickLine={false}
                              axisLine={false}
                              unit=" km"
                            />
                            <YAxis
                              stroke="var(--rp-muted)"
                              fontSize={10}
                              tickLine={false}
                              axisLine={false}
                              unit=" m"
                            />
                            <Tooltip
                              contentStyle={{
                                background: 'var(--md-sys-color-surface-container-high)',
                                border: '1px solid var(--md-sys-color-outline-variant)',
                                borderRadius: 10,
                                fontSize: 12,
                              }}
                              formatter={(value) => [`${value} m`, 'Altitude']}
                            />
                            <Area
                              type="monotone"
                              dataKey="z"
                              stroke="#8fdcff"
                              strokeWidth={2}
                              fill="url(#zGrad)"
                            />
                          </AreaChart>
                        </ResponsiveContainer>
                      ) : (
                        <span className="rp-sim-note">
                          Altitudes BD TOPO absentes sur ces tronçons (« Pas de Z ») : aucun profil
                          n&apos;est interpolé à partir de rien.
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {journeyRows.length > 0 ? (
                  <table className="rp-table rp-table--cmp">
                    <thead>
                      <tr>
                        <th>Fait de géographie</th>
                        <th>Valeur réelle (IGN BD TOPO)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {journeyRows.map(([k, v]) => (
                        <tr key={k}>
                          <td>{k}</td>
                          <td>{v}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
              </>
            ) : null}

          </section>
          {/* ── Graphique : pluie PRÉVUE réelle (Open-Meteo). Aucune courbe n'est
              dessinée si la prévision est indisponible : une courbe
              plate laisserait croire à un événement sans pluie. ── */}
          {/* La section n'existe QUE s'il y a une courbe à montrer. Un cadre
              vide intitulé « aucune pluie prévue » n'apprenait rien : sur une
              journée sèche, le fait tient en une ligne dans « Contexte météo »,
              pas dans un graphique sans données. */}
          {rainData.length > 0 ? (
          <section className="rp-block">
            <h2 className="rp-h2">Pluie prévue (Open-Meteo, mm/h)</h2>
            <div className="rp-charts">
                <div className="rp-chart-card">
                  <div className="rp-chart">
                    <ResponsiveContainer width="100%" height={220}>
                      <AreaChart data={rainData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                        <defs>
                          <linearGradient id="rainGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#4c9aff" stopOpacity={0.5} />
                            <stop offset="100%" stopColor="#4c9aff" stopOpacity={0.02} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                        <XAxis dataKey="hour" stroke="var(--rp-muted)" fontSize={9} tickLine={false} axisLine={false} interval={3} />
                        <YAxis stroke="var(--rp-muted)" fontSize={10} tickLine={false} axisLine={false} allowDecimals={false} />
                        <Tooltip
                          contentStyle={{
                            background: 'var(--md-sys-color-surface-container-high)',
                            border: '1px solid var(--md-sys-color-outline-variant)',
                            borderRadius: 10,
                            fontSize: 12,
                          }}
                        />
                        <Area type="monotone" dataKey="rain" stroke="#4c9aff" strokeWidth={2} fill="url(#rainGrad)" />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>
            </div>
          </section>
          ) : null}

          {/* ── Contexte météo/hydrologique RÉEL — toujours affiché, en une
              ligne de faits : c'est l'information que le graphique vide ne
              portait pas. Aucune valeur simulée, seulement les mesures. ── */}
          <section className="rp-block">
            <h2 className="rp-h2">Contexte météo et hydrologique (sourcé)</h2>
            <ul className="rp-facts rp-facts--compact">
              <li className="rp-fact">
                <span className="rp-fact-label">Pluie prévue sur 24 h</span>
                <span className="rp-fact-value">
                  {meteo
                    ? meteo.dry || rainData.length === 0
                      ? 'Aucune pluie annoncée'
                      : `${meteo.rain_total_mm?.toFixed(1) ?? '—'} mm (pic ${meteo.rain_peak_mm_h?.toFixed(1) ?? '—'} mm/h)`
                    : 'Prévision indisponible'}
                </span>
                <span className="rp-fact-note">{meteo?.sources?.rain ?? 'Open-Meteo'}</span>
              </li>
              <li className="rp-fact">
                <span className="rp-fact-label">Débit estimé (GloFAS)</span>
                <span className="rp-fact-value">
                  {(() => {
                    const d = meteo?.discharge;
                    if (!d || d.series.length === 0) return 'Non fourni pour ce point';
                    const first = d.series[0].v;
                    if (first == null) return 'Non fourni pour ce point';
                    return `${first.toFixed(1)} ${d.unit ?? 'm³/s'}`;
                  })()}
                </span>
                <span className="rp-fact-note">{meteo?.sources?.discharge ?? 'Open-Meteo Flood'}</span>
              </li>
            </ul>
          </section>

          {/* ── Confiance & limites ── */}
          <section className="rp-block">
            <h2 className="rp-h2">Confiance & limites</h2>
            <p className="rp-confidence">
              Aucune estimation de dommages chiffrée : les courbes de vulnérabilité synthétiques
              (style HAZUS) ont été retirées tant qu'aucun référentiel réel d'exposition ne les
              soutient. Le rapport se limite aux <strong>faits sourcés</strong> : aléas Géorisques,
              hydrographie IGN BD TOPO, météo Open-Meteo / GloFAS, exposition BDNB.
            </p>
          </section>

          {/* ── Annexe ── */}
          {stream.appendix && stream.appendix.length > 0 ? (
            <section className="rp-block">
              <h2 className="rp-h2">Annexe — données brutes</h2>
              <table className="rp-table rp-table--annexe">
                <thead>
                  <tr>
                    <th>Indicateur</th>
                    <th>Valeur</th>
                  </tr>
                </thead>
                <tbody>
                  {stream.appendix.map(([k, v]) => (
                    <tr key={k}>
                      <td>{k}</td>
                      <td>{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}

          {/* ── Pied de page ── */}
          <footer className="rp-footer">
            <span className="rp-mention">
              Les informations sur les risques auxquels ce bien est exposé sont disponibles sur le
              site Géorisques : <b>www.georisques.gouv.fr</b>
            </span>
            <span className="rp-meta">
              Modèle&nbsp;: <b>{stream.meta.model ?? 'template-first'}</b> · Cache&nbsp;:{' '}
              <b>{stream.meta.cache_hit ? 'servi depuis le cache' : 'calculé'}</b>
              {stream.meta.generated_at
                ? ` · ${new Date(stream.meta.generated_at).toLocaleString('fr-FR')}`
                : ''}
            </span>
          </footer>
        </div>
      </div>
    </div>
  );
}