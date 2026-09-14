// =============================================================================
//   TYPHOON — /report : page autonome du rapport de risque (étape 3).
//   Page pleine (pas un panneau) : topbar retour/export, bandeau d'identité
//   façon Géorisques, mini-carte de la zone (marqueur + empreinte BDNB),
//   graphiques (dommages par catégorie + trajectoire pluie), tableau de
//   synthèse des risques, détail par catégorie, recommandations, confiance,
//   annexe, mention Géorisques. Le rapport est streamé (SSE) depuis le
//   backend ; l'export PDF se fait via l'impression du navigateur (feuille
//   de style print).
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import mapboxgl from 'mapbox-gl';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Area,
  AreaChart,
} from 'recharts';
import type { RisqueReport } from '../zone/config';
import {
  scenarioFor,
  computeDamage,
  exposureFromReport,
  timeProfileAt,
  fmtMoneyEUR,
  fmtRange,
  type DamageEstimate,
} from '../zone/damageModel';
import {
  buildJourney,
  fetchHydroRoute,
  fetchMeteo,
  fmtHours,
  fmtKm,
  mergeStretch,
  extendHydroStretch,
  sampleAt,
  type HydroRoute,
  type Journey,
  type MeteoData,
} from '../zone/hydroRoute';
import { clearJourney, isJourneyMounted, mountJourney, setDrop, setProgress } from '../zone/hydroLayer';
import { WaterFlight, type FlightRate } from '../zone/waterFlight';
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

const DEFAULTS = { scenarioKey: 'direct', timeMin: 195 };

/** Vitesses de lecture du vol du trajet. */
const FLIGHT_RATES: FlightRate[] = [1, 4, 16];

/** Le DamageEstimate → dictionnaire envoyé au backend (clés identiques au
   schéma pydantic). Utilisé pour le scénario officiel ET pour l'hypothèse,
   afin qu'il n'existe qu'une seule conversion. */
function damageRecord(
  est: DamageEstimate
): Record<string, { v: number; low: number; high: number }> {
  return {
    brokenTrees: est.brokenTrees,
    damagedVehicles: est.damagedVehicles,
    downedPowerLines: est.downedPowerLines,
    floodedConduitM: est.floodedConduitM,
    damagedBuildings: est.damagedBuildings,
    damagedRoadsM: est.damagedRoadsM,
    waterLevelFt: est.waterLevelFt,
    damageEUR: est.damageEUR,
    damageUSD: est.damageUSD,
    hp: est.hp,
  };
}

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

function riskLevelClass(level: string): string {
  return (level ?? '').toLowerCase() || 'unknown';
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
function JourneyMap({
  report,
  journey,
  basinGeometry,
  flight,
  onFlightProgress,
  onFlightEnd,
}: {
  report: RisqueReport | null;
  journey: Journey;
  basinGeometry: GeoJSON.Geometry | null;
  flight: { playing: boolean; rate: FlightRate; seekKm: number; seekNonce: number };
  onFlightProgress: (km: number, fraction: number) => void;
  onFlightEnd: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const flightRef = useRef<WaterFlight | null>(null);

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
      flightRef.current?.destroy();
      flightRef.current = null;
      clearJourney(map);
      map.remove();
      mapRef.current = null;
    };
  }, [report, journey, basinGeometry]);

  /* Même vol que l'application : une instance par trajet. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isJourneyMounted(map)) return;
    const instance = new WaterFlight(map, journey, {
      onProgress: (km, fraction) => {
        const p = sampleAt(journey.coords, journey.cum, km, null);
        if (p) setDrop(map, { lon: p.lon, lat: p.lat });
        setProgress(map, fraction);
        onFlightProgress(km, fraction);
      },
      onEnd: onFlightEnd,
    });
    flightRef.current = instance;
    return () => {
      instance.destroy();
      flightRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journey]);

  useEffect(() => {
    const instance = flightRef.current;
    if (!instance) return;
    if (flight.playing) instance.play();
    else instance.pause();
  }, [flight.playing]);

  useEffect(() => {
    flightRef.current?.setRate(flight.rate);
  }, [flight.rate]);

  useEffect(() => {
    flightRef.current?.seek(flight.seekKm);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flight.seekNonce]);

  return <div className="rp-map" ref={ref} />;
}

/* ── Données des graphiques ── */
function damageChartData(est: DamageEstimate): { label: string; value: number; full: string }[] {
  const rows: { label: string; value: number; full: string }[] = [];
  const items: [string, { v: number; low: number; high: number }, string][] = [
    ['Arbres', est.brokenTrees, 'arbres cassés'],
    ['Véhicules', est.damagedVehicles, 'véhicules'],
    ['Lignes (km)', est.downedPowerLines, 'km de ligne'],
    ['Conduites (m)', est.floodedConduitM, 'm submergés'],
    ['Bâtiments', est.damagedBuildings, 'bâtiments'],
    ['Voirie (m)', est.damagedRoadsM, 'm inondés'],
  ];
  for (const [label, r, unit] of items) {
    rows.push({ label, value: Math.round(r.v), full: `${fmtRange(r)} ${unit}` });
  }
  return rows;
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

export function ReportPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const state = (location.state ?? {}) as ZoneState;

  /* Si on arrive sans état (rechargement), on retombe sur le diagnostic le
     plus récent du cache local. */
  const initial = useMemo((): ZoneState => {
    if (state.report) {
      return {
        place: state.place,
        report: state.report,
        scenarioKey: state.scenarioKey ?? DEFAULTS.scenarioKey,
        timeMin: state.timeMin ?? DEFAULTS.timeMin,
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
  const [hydroExtending, setHydroExtending] = useState(false);
  const [meteo, setMeteo] = useState<MeteoData | null>(null);

  const [flightPlaying, setFlightPlaying] = useState(false);
  const [flightRate, setFlightRate] = useState<FlightRate>(1);
  const [flightKm, setFlightKm] = useState(0);
  const [seekKm, setSeekKm] = useState(0);
  const [seekNonce, setSeekNonce] = useState(0);

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
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report]);

  const extendHydro = useCallback(
    async (direction: 'up' | 'down') => {
      if (!hydro || hydroExtending) return;
      const stretch = direction === 'down' ? hydro.downstream : hydro.upstream;
      if (!stretch?.cursor) return;
      setHydroExtending(true);
      try {
        const more = await extendHydroStretch(stretch.cursor);
        if (more && more.segments > 0) {
          setHydro({
            ...hydro,
            [direction === 'down' ? 'downstream' : 'upstream']: mergeStretch(stretch, more),
          });
        }
      } finally {
        setHydroExtending(false);
      }
    },
    [hydro, hydroExtending]
  );

  /* Instant t + estimation = exactement la même source que le panneau gauche. */
  const scenario = scenarioFor(scenarioKey);
  const exposure = useMemo(() => exposureFromReport(report), [report]);

  const payload: ReportPayload | null = useMemo(() => {
    if (!report) return null;
    const time = timeProfileAt(timeMin / 60);
    const estOne = computeDamage(exposure, scenario, time);
    const now = new Date();
    const hh = String(Math.floor(timeMin / 60)).padStart(2, '0');
    const mm = String(timeMin % 60).padStart(2, '0');
    return {
      sector: place ?? report.adresse_normalisee ?? 'Secteur',
      timestamp: `${now.toISOString().slice(0, 10)}T${hh}:${mm}:00`,
      scenario: {
        key: scenario.key,
        pct: scenario.pct,
        risk: scenario.risk,
        windPeakKmh: scenario.windPeakKmh,
        rainPeakMmH: scenario.rainPeakMmH,
        depthPeakM: scenario.depthPeakM,
      },
      damage: damageRecord(estOne),
      /* Trajet de l'eau RÉEL : un résumé de géographie, aucune valeur simulée.
         Absent → rapport inchangé (la clé de cache côté serveur ne bouge pas). */
      hydro: hydroSummary(hydro),
    };
  }, [report, place, scenario, exposure, timeMin, hydro]);

  const stream = useReportStream(payload);

  const est = useMemo(
    () => computeDamage(exposure, scenario, timeProfileAt(timeMin / 60)),
    [exposure, scenario, timeMin]
  );

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

  const orderedCats = useMemo(
    () => stream.catOrder.map((k) => stream.cats[k]).filter((c) => !!c),
    [stream.catOrder, stream.cats]
  );

  const exportPdf = () => {
    window.print();
  };

  if (!report) {
    return (
      <div className="rp-page">
        <div className="rp-topbar">
          <button className="rp-back" onClick={() => navigate('/zone')}>
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
        <button className="rp-back" onClick={() => navigate('/zone')}>
          <md-icon aria-hidden="true">arrow_back</md-icon>
          <span>Retour à la carte</span>
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
                  <span className="rp-ident-val">
                    {stream.header.scenario} · {stream.header.pct} %
                  </span>
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

          {/* ── Synthèse + Localisation (colonne gauche) ── */}
          <div className="rp-cols">
            <div className="rp-col">
          {stream.summary ? (
            <section className="rp-block">
              <h2 className="rp-h2">Synthèse</h2>
              <div className="rp-stats">
                <div className="rp-stat">
                  <span className="rp-stat-val">{stream.summary.damageEUR}</span>
                  <span className="rp-stat-label">Dommages estimés</span>
                  <span className="rp-stat-sub">fourchette {stream.summary.damageRange}</span>
                </div>
                <div className="rp-stat">
                  <span className="rp-stat-val">{stream.summary.hp}</span>
                  <span className="rp-stat-label">Habitations touchées</span>
                </div>
                <div className="rp-stat">
                  <span className="rp-stat-val">{stream.summary.waterLevelFt} ft</span>
                  <span className="rp-stat-label">Niveau d'eau</span>
                </div>
              </div>
              <p className="rp-summary-text">{stream.summary.executive_summary}</p>
            </section>
          ) : null}

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
          </div>
          </div>

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
                        flight={{ playing: flightPlaying, rate: flightRate, seekKm, seekNonce }}
                        onFlightProgress={setFlightKm}
                        onFlightEnd={() => setFlightPlaying(false)}
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

                  <div className="rp-hydro-side">
                    <div className="rp-sim-transport">
                      <button
                        type="button"
                        className="rp-sim-play"
                        aria-label={flightPlaying ? 'Pause' : 'Suivre le trajet'}
                        onClick={() => setFlightPlaying((p) => !p)}
                      >
                        <md-icon aria-hidden="true">
                          {flightPlaying ? 'pause' : 'play_arrow'}
                        </md-icon>
                      </button>
                      <span className="rp-sim-clock">
                        {fmtKm(flightKm)} / {fmtKm(journey.totalKm)}
                      </span>
                      <div className="rp-hydro-rates" role="group" aria-label="Vitesse du vol">
                        {FLIGHT_RATES.map((r) => (
                          <button
                            key={r}
                            type="button"
                            className={`rp-hydro-rate${flightRate === r ? ' on' : ''}`}
                            aria-pressed={flightRate === r}
                            onClick={() => setFlightRate(r)}
                          >
                            {r}×
                          </button>
                        ))}
                      </div>
                    </div>

                    <label className="rp-sim-slider">
                      <span className="rp-sim-slider-label">Position sur le parcours</span>
                      <input
                        type="range"
                        min={0}
                        max={Math.max(0.1, journey.totalKm)}
                        step={0.05}
                        value={Math.min(flightKm, journey.totalKm)}
                        onChange={(e) => {
                          setFlightPlaying(false);
                          const km = Number(e.target.value);
                          setSeekKm(km);
                          setSeekNonce((n) => n + 1);
                          setFlightKm(km);
                        }}
                        aria-label="Position sur le parcours reconstruit (km)"
                      />
                      <b>{fmtKm(flightKm)}</b>
                    </label>

                    {hydro?.upstream?.has_more ? (
                      <button
                        type="button"
                        className="rp-hydro-extend"
                        disabled={hydroExtending}
                        onClick={() => void extendHydro('up')}
                      >
                        <md-icon aria-hidden="true">north</md-icon>
                        {hydroExtending ? 'Prolongation…' : 'Prolonger le parcours en amont'}
                      </button>
                    ) : null}
                    {hydro?.downstream?.has_more ? (
                      <button
                        type="button"
                        className="rp-hydro-extend"
                        disabled={hydroExtending}
                        onClick={() => void extendHydro('down')}
                      >
                        <md-icon aria-hidden="true">south</md-icon>
                        {hydroExtending ? 'Prolongation…' : 'Prolonger le parcours en aval'}
                      </button>
                    ) : null}

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
          {/* ── Graphiques (colonne droite) ── */}
          <div className="rp-cols">
            <div className="rp-col">
          {est ? (
            <section className="rp-block">
              <h2 className="rp-h2">Estimation des dommages</h2>
              <div className="rp-charts">                  <div className="rp-chart-card">

                  <span className="rp-chart-title">Dommages par catégorie</span>
                  <div className="rp-chart">
                    <ResponsiveContainer width="100%" height={220}>
                      <BarChart data={damageChartData(est)} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                        <XAxis dataKey="label" stroke="var(--rp-muted)" fontSize={10} tickLine={false} axisLine={false} />
                        <YAxis stroke="var(--rp-muted)" fontSize={10} tickLine={false} axisLine={false} allowDecimals={false} />
                        <Tooltip
                          cursor={{ fill: 'rgba(255,255,255,0.06)' }}
                          contentStyle={{
                            background: 'var(--md-sys-color-surface-container-high)',
                            border: '1px solid var(--md-sys-color-outline-variant)',
                            borderRadius: 10,
                            fontSize: 12,
                          }}
                          formatter={(value, name, item) => [`${item?.payload?.full ?? value}`, 'Estimation']}
                        />
                        <Bar dataKey="value" fill="#ff3b30" radius={[5, 5, 0, 0]} maxBarSize={44} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                {/* Pluie PRÉVUE réelle (Open-Meteo). Aucune courbe n'est
                    dessinée si la prévision est indisponible : une courbe
                    plate laisserait croire à un événement sans pluie. */}
                <div className="rp-chart-card">
                  <span className="rp-chart-title">
                    Pluie prévue (mm/h, Open-Meteo)
                    {meteo?.dry ? ' — aucune pluie prévue' : ''}
                  </span>
                  {rainData.length === 0 ? (
                    <span className="rp-chart-empty">
                      Prévision de pluie indisponible — aucune trajectoire n'est inventée.
                    </span>
                  ) : (
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
                  )}
                </div>
              </div>
            </section>
          ) : null}

          {/* ── Tableau de synthèse des risques ── */}
          {orderedCats.length > 0 ? (
            <section className="rp-block">
              <h2 className="rp-h2">Tableau de synthèse des risques</h2>
              <table className="rp-table">
                <thead>
                  <tr>
                    <th>Catégorie</th>
                    <th>Niveau</th>
                    <th>Estimation</th>
                  </tr>
                </thead>
                <tbody>
                  {orderedCats.map((c) => (
                    <tr key={c.category}>
                      <td>
                        <md-icon aria-hidden="true">{categoryIcon(c.category)}</md-icon>
                        <span>{c.label}</span>
                      </td>
                      <td>
                        <span className={`rp-badge rp-badge--${riskLevelClass(c.risk_level)}`}>{c.risk_level}</span>
                      </td>
                      <td className="rp-cell-est">
                        {c.estimate} {c.unit}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}

          {/* ── Détail par catégorie ── */}
          {orderedCats.length > 0 ? (
            <section className="rp-block">
              <h2 className="rp-h2">Détail par catégorie</h2>
              <div className="rp-cats">
                {orderedCats.map((c) => (
                  <div className="rp-catcard" key={c.category}>
                    <div className="rp-catcard-head">
                      <md-icon aria-hidden="true">{categoryIcon(c.category)}</md-icon>
                      <span className="rp-catcard-label">{c.label}</span>
                      <span className={`rp-badge rp-badge--${riskLevelClass(c.risk_level)}`}>{c.risk_level}</span>
                    </div>
                    <p className="rp-catcard-text">{c.narrative}</p>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {/* ── Recommandations de mitigation ── */}
          {stream.status !== 'loading' ? (
            <section className="rp-block">
              <h2 className="rp-h2">Recommandations de mitigation</h2>
              {stream.migs.length === 0 ? (
                <p className="rp-empty-mig">
                  Aucune action de mitigation ne dépasse le seuil de déclenchement.
                </p>
              ) : (
                <ol className="rp-migs">
                  {stream.migs.map((m) => (
                    <li key={m.id}>
                      <div className="rp-mig-head">
                        <span className="rp-mig-cat">{cap(m.category)}</span>
                        <span className="rp-mig-trigger">déclenché : {m.trigger}</span>
                      </div>
                      <p className="rp-mig-text">{m.narrative ?? m.text}</p>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          ) : null}

          {/* ── Confiance & limites ── */}
          {stream.confidence ? (
            <section className="rp-block">
              <h2 className="rp-h2">Confiance & limites</h2>
              <p className="rp-confidence">
                Estimation modélisée à partir des données météo du scénario, de l'exposition du
                secteur et de courbes de vulnérabilité (méthodologie de type HAZUS). Ce ne sont{' '}
                <strong>pas des dommages observés</strong>. Fourchette d'incertitude : dommages
                estimés {stream.confidence.low} – {stream.confidence.high}.
              </p>
            </section>
          ) : null}

          {/* ── Annexe ── */}
          {stream.appendix && stream.appendix.length > 0 ? (
            <section className="rp-block">
              <h2 className="rp-h2">Annexe — données brutes</h2>
              <table className="rp-table rp-table--annexe">
                <thead>
                  <tr>
                    <th>Indicateur</th>
                    <th>Estimation ±</th>
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

          </div>
          </div>

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