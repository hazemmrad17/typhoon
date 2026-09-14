// =============================================================================
//   TYPHOON — /zone : tableau de bord inondation (page de référence unique)
//   Écran France plein écran :
//     · topbar — hamburger + indicateur de région (icône monde) + recherche
//       d'adresse + bouton « + » (simulation) ;
//     · carte Mapbox Standard plein écran (régions France, 3D, particules
//       de vent selon la carte météo) ;
//     · panneaux gauches — Population / Dommages par industrie / Infrastructures ;
//     · panneau droit — Alertes de la zone / portefeuille ;
//     · console météo basse — période + timeline + 4 cartes météo + toggles
//       Flood Mapping / Forecast.
//   Le diagnostic d'adresse (POST /diagnostic/adresse) recentre la carte sur
//   l'adresse. Les anciennes étapes « stepper » (Cartographie / Analyse /
//   Recommandations / Artisans) ont été supprimées — cette page est la seule.
// =============================================================================

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { UnifiedMap } from '../components/UnifiedMap';
import { ZoneSidenav, useIsMobile } from '../components/ZoneSidenav';
import { FloodConsole } from '../components/FloodConsole';
import { LeftPanels } from '../components/LeftPanels';
import { RightAlertsPanel } from '../components/RightAlertsPanel';
import { RiskPanel } from '../components/RiskPanel';
import { ScenarioPanel } from '../components/ScenarioPanel';
import { RiskConsole } from '../components/RiskConsole';
import { useTyphoonTheme } from '../typhoon/useTyphoonTheme';
import { useUserProfile } from '../typhoon/useUserProfile';
import { useAuth } from '../typhoon/auth';
import {
  loadCatNatLatest,
  recordCatNatLatest,
  saveCatNatLatest,
} from '../zone/watchlist';
import {
  API,
  type GeocodeSuggestion,
  type RisqueReport,
} from '../zone/config';
import { toRisqueReportView, type CanonicalRecord } from '../zone/canonicalAdapter';
import {
  addConversation,
  loadConversations,
  saveConversations,
  type Conversation,
} from '../zone/conversations';
import {
  getCachedDiagnostic,
  putCachedDiagnostic,
} from '../zone/diagnosticCache';
import {
  buildJourney,
  fetchHydroRoute,
  fetchMeteo,
  type HydroRoute,
  type MeteoData,
} from '../zone/hydroRoute';
import { fetchSitePhoto, type SitePhoto } from '../zone/sitePhoto';
import { scenarioFor, timeProfileAt } from '../zone/damageModel';
import { impactAt } from '../zone/impactModel';
import '../styles/zone.css';


export function Zone() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { theme, accent, mode, setThemeMode } = useTyphoonTheme();
  const { profile } = useUserProfile();
  const { signOut } = useAuth();
  const isMobile = useIsMobile();
  /* /zone n'a pas de rail persistant (structure « carte plein écran ») : la
     navigation vit dans un drawer à la demande, ouvert via le hamburger du
     stepper — même principe qu'en mobile. */
  const [drawerOpen, setDrawerOpen] = useState(false);
  const sidenavRef = useRef<HTMLElement | null>(null);

  /* Drawer ouvert : amener le focus dans la navigation. */
  useEffect(() => {
    if (!drawerOpen) return;
    const first = sidenavRef.current?.querySelector<HTMLElement>(
      'a, [tabindex]:not([tabindex="-1"])'
    );
    first?.focus();
  }, [drawerOpen]);

  /* Arrivée depuis /settings (historique « Récent ») : ?q=<adresse> lance
     directement le diagnostic au montage. On consomme le ref pour ne pas
     relancer sous React StrictMode (double effet en dev). */
  const bootQuery = useRef(searchParams.get('q'));
  useEffect(() => {
    const q = bootQuery.current;
    bootQuery.current = null;
    if (q) void runDiagnosis(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [suggestions, setSuggestions] = useState<GeocodeSuggestion[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  /* Zone sélectionnée (région de la carte France ou commune d'une adresse
     suggérée) : affichée dans le placeholder de la recherche. */
  const [selectedPlace, setSelectedPlace] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [diagError, setDiagError] = useState<string | null>(null);
  const [report, setReport] = useState<RisqueReport | null>(null);
  const [, setConversations] = useState<Conversation[]>(() => loadConversations());
  const [, setCatNatLatest] = useState<Record<string, number>>(() => loadCatNatLatest());
  /* Carte métrique active de la console (temp/wind/pressure/rainfall) —
     relayée à la carte : « Wind » affiche les particules de vent. */
  /* Carte météo sélectionnée : AUCUNE par défaut — l'utilisateur choisit, et
     un SECOND clic sur la même carte la coupe. Rien ne s'active
     automatiquement. '' = aucune carte météo (perf : aucune couche chargée
     inutilement) — et aucune timeline : elle n'existe qu'avec une carte
     active, puisqu'elle sert à dater la couche que la carte affiche. */
  const [selectedMetric, setSelectedMetric] = useState('');
  /* Index de l'heure de prévision (time-aware) — piloté par la timeline de
     la console, relayé à la carte pour sélectionner la valid_time OM. */
  const [weatherTime, setWeatherTime] = useState(3);
  /* Toggle FLOOD de la console (étape 1) : Flood Mapping force l'aléa
     inondation Géorisques (WMS LIMITETRI), le zonage réglementaire réel. */
  const [floodMapping, setFloodMapping] = useState(false);
  /* Alerte sélectionnée depuis le panneau droit « Alertes » : la carte vole
     vers le tronçon et pose un indicateur animé. */
  const [alertFocus, setAlertFocus] = useState<{
    lat: number;
    lon: number;
    name: string;
    level: number;
  } | null>(null);
  /* Toutes les alertes affichées par le panneau droit : la carte pose un
     indicateur coloré (cloche) par tronçon de vigilance. */
  const [alertMarkers, setAlertMarkers] = useState<
    { lat: number; lon: number; name: string; level: number }[]
  >([]);
  /* Aléas explicitement RENDUS visibles par l'utilisateur (toggle œil sur
     ON dans le panneau gauche). Par défaut (avant toute interaction),
     AUCUN aléa n'est affiché — l'utilisateur ouvre l'œil de ce qu'il veut
     voir. Aucun allumage automatique au diagnostic : c'est lui qui décide. */
  const [visibleAleas, setVisibleAleas] = useState<Set<string>>(new Set());
  /* Parcours en 3 étapes : 1 = carte / crues, 2 = analyse des risques,
     3 = rapport (page autonome /report). La flèche de la topbar avance
     d'une étape à l'autre.

     La classe risk-open est posée dès l'étape 2 et change la composition :
       · la console météo de l'étape 1 s'escamote, remplacée en bas par la
         console d'évaluation (.risk-console : suivi + règle temporelle) ;
       · le panneau d'évaluation des risques (.risk-panel) prend le bord
         gauche et le panneau des scénarios (.scenario-panel) le bord droit ;
       · les colonnes de l'étape 1 (commune + aléas à gauche, vigilance à
         droite) sont retirées : elles occupent les mêmes bords mais une
         largeur différente (487 px contre 380 px à 1918 px), donc les garder
         empilait deux colonnes décalées l'une sur l'autre.

     Restauré depuis le snapshot safety/pre-water-sim : cette vue porte le
     moteur de dommages et les scénarios, donc des estimations et des niveaux
     de risque que la constitution §2 n'autorise pas encore (amendement
     différé, expérience assumée). */
  const [step, setStep] = useState(1);
  const isRiskView = step >= 2;

  /* Le passage à l'étape 2 est conditionné au diagnostic : les panneaux de
     risque, le moteur de dommages et la console de simulation n'ont aucune
     donnée à montrer sans adresse (et une carte centrée sur la France
     n'expose aucun aléa). Le bouton est donc désactivé, et `nextStep`
     re-vérifie la condition — un bouton désactivé n'est pas une garde à lui
     seul (appel programmatique, raccourci clavier, état restauré).
     Retour arrière toujours permis : on ne piège jamais l'utilisateur. */
  const stepLocked = step === 1 && !report;
  const nextStep = () => {
    if (step === 1 && !report) return;
    setStep((s) => (s >= 3 ? 1 : s + 1));
  };

  /* Invariant rattrapé : « étape ≥ 2 ⇒ un diagnostic ». Le bouton et `nextStep`
     couvrent l'aller ; ceci couvre le retour — une adresse effacée, un
     diagnostic relancé puis échoué, ou un état restauré ne doivent pas laisser
     la vue risques ouverte sur des panneaux vides. On attend la fin du
     diagnostic en cours (`loading`) pour ne pas ejecter l'utilisateur pendant
     qu'il change d'adresse. */
  useEffect(() => {
    if (!report && !loading && step > 1) setStep(1);
  }, [report, loading, step]);

  /* Passage à l'étape 2 : les aléas ouverts à l'œil à l'étape 1 sont
     désactivés — la vue risques porte ses propres couches (enveloppe du
     moteur, trajet de l'eau), et les couches d'aléas de l'étape 1 n'ont
     rien à y faire. Retour à l'étape 1 : l'utilisateur re-toggles lui-même. */
  useEffect(() => {
    if (step >= 2) setVisibleAleas(new Set());
  }, [step]);

  /* Étape 2 — état partagé du moteur de dommages :
     · scenarioKey  — scénario sélectionné (panneau droit) qui pilote la bande
       d'intensité des estimations du panneau gauche ;
     · riskTimeMin  — minute de la journée (console basse) qui pilote l'instant
       t de l'événement. Les deux déclenchent le recalcul des deux panneaux. */
  const [scenarioKey, setScenarioKey] = useState('direct');
  const [riskTimeMin, setRiskTimeMin] = useState(195);

  /* ── Trajet de l'eau (étape 2) : GÉOGRAPHIE RÉELLE, reconstruite côté
     serveur (réseau hydrographique IGN BD TOPO, cf. zone/hydroRoute.ts).
     Le tracé revient en quelques secondes (25 tronçons ≈ 39 km) : la carte
     affiche la distance et l'arrêt réellement reconstruits, jamais une
     emprise inventée. */
  const [hydro, setHydro] = useState<HydroRoute | null>(null);

  /* Référence météo/hydrologique RÉELLE (pluie prévue Open-Meteo, débit
     GloFAS) — affichée à côté de l'enveloppe de scénario, jamais fusionnée
     avec elle. Indisponible → null, la console le dit explicitement. */
  const [meteo, setMeteo] = useState<MeteoData | null>(null);

  /* Photo terrain RÉELLE du secteur (Panoramax) — support visuel des cartes de
     scénarios. Aucun fonds d'images générique : si le secteur n'est pas couvert,
     `photo` est null ou `available === false` et les cartes gardent leur visuel
     abstrait. Rien n'est substitué en silence. */
  const [photo, setPhoto] = useState<SitePhoto | null>(null);

  /* Enveloppe d'inondation portée à la carte (étape 2) : la profondeur du
     MOTEUR (scénario × instant de la timeline), dans l'empreinte réelle du
     bâti de la vue. Le seuil d'infrastructure du moteur (0,3 m) est une
     frontière : en dessous, il ne compte aucun dommage, donc la carte ne
     peint aucune eau — `null` plutôt qu'un volume symbolique. */
  const riskImpact = useMemo(() => {
    if (!isRiskView) return null;
    const state = impactAt(scenarioFor(scenarioKey), timeProfileAt(riskTimeMin / 60).accum);
    return state.overThreshold ? { slabM: state.slabM, color: state.band.color } : null;
  }, [isRiskView, scenarioKey, riskTimeMin]);

  const journey = useMemo(() => (hydro ? buildJourney(hydro) : null), [hydro]);
  const basinGeometry = hydro?.basin?.geometry ?? null;

  /* Reconstruction du trajet à chaque nouveau site diagnostiqué. Aucun échec
     réseau ne casse l'écran : `hydro` reste null, aucun tracé n'est dessiné. */
  useEffect(() => {
    if (!report) {
      setHydro(null);
      return;
    }
    const ctrl = new AbortController();
    fetchHydroRoute(report.lat, report.lon, undefined, ctrl.signal).then((res) => {
      if (!ctrl.signal.aborted) setHydro(res);
    });
    return () => ctrl.abort();
  }, [report]);

  /* Référence réelle météo / hydrologie du même point (Open-Meteo, GloFAS). */
  useEffect(() => {
    if (!report) {
      setMeteo(null);
      return;
    }
    const ctrl = new AbortController();
    fetchMeteo(report.lat, report.lon, ctrl.signal).then((res) => {
      if (!ctrl.signal.aborted) setMeteo(res);
    });
    return () => ctrl.abort();
  }, [report]);

  /* Photo terrain du secteur (Panoramax) — même règle que le reste : on ne
     montre que ce qui existe, et le panneau affiche la provenance ou l'absence. */
  useEffect(() => {
    if (!report) {
      setPhoto(null);
      return;
    }
    const ctrl = new AbortController();
    fetchSitePhoto(report.lat, report.lon, ctrl.signal).then((res) => {
      if (!ctrl.signal.aborted) setPhoto(res);
    });
    return () => ctrl.abort();
  }, [report]);

  /* Étape 3 = page rapport autonome (/report) : on y accède directement, sans
     bouton intermédiaire. On emporte l'état courant (lieu + rapport + scénario
     + instant t + trajet). Le rapport reprend le scénario et l'heure choisis à
     l'étape 2 : changer de bande d'intensité ou déplacer le curseur change le
     document produit, plutôt que d'en produire un indépendant. */
  useEffect(() => {
    if (step === 3 && report) {
      navigate('/report', {
        state: {
          place: selectedPlace,
          report,
          scenarioKey,
          timeMin: riskTimeMin,
          /* Le rapport reprend le trajet RÉEL en cours (résumé du parcours
             reconstruit) — aucune hypothèse simulée n'est transmise. */
          hydro,
        },
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  /* Champ de recherche de l'écran France (étape Adresse) : input natif. */
  const heroInputRef = useRef<HTMLInputElement>(null);
  const lastQuery = useRef('');
  const banTimeout = useRef<number | null>(null);

  /* ── BAN autocomplétion ── */
  function fetchSuggestions(q: string) {
    fetch(`${API}/api/geocode/search?q=${encodeURIComponent(q)}&limit=5`)
      .then((resp) => (resp.ok ? resp.json() : Promise.reject(new Error(`HTTP ${resp.status}`))))
      .then((data) => {
        setSuggestions(data.results || []);
        setSuggestionsOpen(true);
      })
      .catch(() => hideSuggestions());
  }

  function hideSuggestions() {
    setSuggestionsOpen(false);
  }

  function onQueryChange(value: string) {
    lastQuery.current = value;
    setDiagError(null); // l'erreur d'API se dissipe dès la saisie
    if (banTimeout.current) window.clearTimeout(banTimeout.current);
    if (value.trim().length < 3) {
      hideSuggestions();
      return;
    }
    banTimeout.current = window.setTimeout(() => fetchSuggestions(value.trim()), 220);
  }

  function pickSuggestion(s: GeocodeSuggestion) {
    lastQuery.current = s.label;
    hideSuggestions();
    void runDiagnosis(s.label);
    /* La commune prime sur l'adresse complète dans l'étiquette de zone : on
       la pose après runDiagnosis pour que ce soit la dernière valeur dans le
       lot d'états (elle gagne la mise à jour React). */
    if (s.city) setSelectedPlace(s.city);
  }

  /* ── Diagnostic ──  Le cache local (façon « historique ChatGPT ») sert la
     même adresse instantanément sans refetch. À l'écran France unique, le
     diagnostic récupère le rapport (lat/lon) et la carte se recentre sur
     l'adresse. */
  async function runDiagnosis(q: string) {
    const value = q.trim();
    if (!value) {
      setDiagError('Saisissez une adresse.');
      return;
    }
    hideSuggestions();
    setDiagError(null);
    /* L'adresse saisie devient la zone affichée (étiquette près de l'icône
       monde et placeholder de la recherche). */
    setSelectedPlace(value);

    /* Cache local : si l'adresse a déjà été diagnostiquée (et est encore
       fraîche), on restitue le rapport complet sans aucun appel réseau. */
    const cached = getCachedDiagnostic(value);
    if (cached) {
      setReport(cached.report);
      setConversations((prev) => {
        const next = addConversation(prev, cached.report.adresse_normalisee || value);
        saveConversations(next);
        return next;
      });
      return;
    }

    setLoading(true);
    setReport(null);

    try {
      const resp = await fetch(`${API}/diagnostic/adresse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adresse: value }),
      });

      if (!resp.ok) {
        let detail = `Erreur ${resp.status}`;
        try {
          const err = await resp.json();
          detail = err.detail?.detail || err.detail?.error || JSON.stringify(err.detail) || detail;
        } catch {
          /* corps non-JSON */
        }
        setDiagError(detail);
        return;
      }

      const record = (await resp.json()) as CanonicalRecord;
      const view = toRisqueReportView(record);
      setReport(view);
      /* Watchlist : enregistre le dernier comptage CatNat observé pour cette
         adresse (données déjà fetchées — alimente le badge sans appel réseau). */
      const catnatCount = (view.aleas || []).reduce(
        (acc, a) => acc + (a.catnat_historique?.length ?? 0),
        0
      );
      setCatNatLatest((prev) => {
        const next = recordCatNatLatest(prev, view.adresse_normalisee || value, catnatCount);
        saveCatNatLatest(next);
        return next;
      });
      putCachedDiagnostic(view); // sauvegarde le résultat pour les prochains passages
      /* Historique « Récent » (localStorage). */
      setConversations((prev) => {
        const next = addConversation(prev, view.adresse_normalisee || value);
        saveConversations(next);
        return next;
      });
    } catch {
      setDiagError('Erreur réseau — backend inaccessible ?');
    } finally {
      setLoading(false);
    }
  }

  /* ── Nouveau diagnostic : retour à l'écran France vierge ── */
  function startNewDiagnostic() {
    setDrawerOpen(false);
    setReport(null);
    setSelectedPlace(null);
    setDiagError(null);
    lastQuery.current = '';
    window.setTimeout(() => heroInputRef.current?.focus(), 80);
  }

  return (
    <main
      className={`zone-app nav-offcanvas${theme === 'light' ? ' theme-light' : ''}${drawerOpen ? ' drawer-open' : ''}${
        !isMobile ? ' map-scene' : ''
      }${isRiskView ? ' risk-open' : ''} step-${step}`}
      style={{ '--accent': accent } as CSSProperties}
    >
      {/* ===== SIDENAV rétractable (navigation façon Gemini) ===== */}
      <ZoneSidenav
        sidenavRef={sidenavRef}
        collapsed={false}
        mobile
        hidden={!drawerOpen}
        theme={theme}
        mode={mode}
        onThemeModeChange={setThemeMode}
        onToggleCollapse={() => setDrawerOpen(false)}
        onOpenAccount={() => {
          setDrawerOpen(false);
          navigate('/settings/account');
        }}
        onNavigateSettings={(tab) => {
          setDrawerOpen(false);
          navigate(`/settings/${tab}`);
        }}
        onSignOut={() => {
          void signOut();
          setDrawerOpen(false);
          navigate('/');
        }}
        onCloseDrawer={() => setDrawerOpen(false)}
        onNewDiagnostic={startNewDiagnostic}
        onNavigate={(path) => {
          setDrawerOpen(false);
          navigate(path);
        }}
        profile={profile}
        activePath={location.pathname}
      />

      {/* ===== COLONNE PRINCIPALE ===== */}
      <div className="zone-main">
        {/* ===== PANNEAUX GAUCHES — population / industries / infrastructures =====
            Colonne indépendante à gauche de l'écran (au-dessus de la console
            météo), chaque panneau défilant sous sa propre scrollbar. */}
        <LeftPanels
          place={selectedPlace}
          report={report}
          onVisibleChange={(v) => setVisibleAleas(v)}
        />
        {/* ===== PANNEAU DROIT — alertes de la zone / portefeuille ===== */}
        <RightAlertsPanel
          report={report}
          onFocusAlert={(a) => setAlertFocus(a)}
          onAlertsChange={(a) => setAlertMarkers(a)}
        />
        {/* ===== ÉCRAN FRANCE — recherche seule (pas de nav/stepper) ===== */}
        <div className="zone-topbar">
          {/* Coin supérieur gauche : hamburger (ouvre le drawer) + indicateur
              « région/adresse » (icône monde) + étiquette de zone. */}
          <div className="loc-chip">
            <md-icon-button
              className="sidenav-hamburger"
              aria-label="Ouvrir le menu"
              onClick={() => setDrawerOpen(true)}
            >
              <md-icon>menu</md-icon>
            </md-icon-button>
            <button
              type="button"
              className={`loc-indicator${selectedPlace ? ' active' : ''}`}
              aria-label={selectedPlace ? `Zone sélectionnée : ${selectedPlace}` : 'Sélectionner une région'}
              title={selectedPlace ? `Zone sélectionnée : ${selectedPlace}` : 'Sélectionner une région sur la carte'}
              onClick={() => heroInputRef.current?.focus()}
            >
              <md-icon aria-hidden="true">public</md-icon>
            </button>
            <span
              className={`loc-chip-label${selectedPlace ? ' active' : ''}`}
              aria-live="polite"
            >
              {selectedPlace ?? 'Sélectionner une région'}
            </span>
          </div>
          <HeroAddressField
            fieldRef={heroInputRef}
            initialValue={lastQuery.current}
            placeholder={selectedPlace ?? 'Rechercher une adresse en France…'}
            suggestions={suggestions}
            suggestionsOpen={suggestionsOpen}
            onQueryChange={onQueryChange}
            onHideSuggestions={hideSuggestions}
            onPick={pickSuggestion}
            onDiagnose={(v) => void runDiagnosis(v)}
            stepError={false}
            loading={loading}
            error={diagError}
            shake={!!diagError}
          />            {/* Chip d'étape : « étape N / 3 » à gauche de la flèche. */}
            <StepChip step={step} total={3} locked={stepLocked} />
            <button
              type="button"
              className={`sim-indicator${step < 3 ? ' forward' : ' back'}${stepLocked ? ' is-locked' : ''}`}
              disabled={stepLocked}
              aria-label={
                stepLocked
                  ? 'Étape 2 indisponible : saisissez d\u2019abord une adresse'
                  : step >= 3
                    ? 'Revenir à la carte'
                    : `Étape suivante : étape ${step + 1} sur 3`
              }
              title={
                stepLocked
                  ? 'Saisissez d\u2019abord une adresse : l\u2019analyse des risques porte sur un bien précis'
                  : step >= 3
                    ? 'Revenir à la carte'
                    : 'Étape suivante'
              }
              onClick={nextStep}
            >
              <md-icon aria-hidden="true">
                {stepLocked ? 'lock' : step >= 3 ? 'arrow_back' : 'arrow_forward'}
              </md-icon>
            </button>
          {loading ? (
            <div className="hero-thinking" role="status" aria-live="polite">
              <span className="hero-thinking-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span className="hero-thinking-txt">Diagnostic en cours…</span>
            </div>
          ) : (
            diagError && (
              <div className="hero-error" role="alert">
                <md-icon>error</md-icon>
                <span>{diagError}</span>
              </div>
            )
          )}
        </div>

        {/* ===== CARTE FRANCE plein écran (mode overview) ===== */}
        <section className="zone-hero">
          {/* Carte France en arrière-plan (mode « overview » : ni chrome, ni
              couches, limites administratives visibles). Éclairage assorti au
              thème (nuit en sombre → carte sombre type EVpin ; jour en
              clair). Après un diagnostic, la carte se recentre sur l'adresse
              (focus) tout en restant sur cet écran. */}
          <div className="zone-hero-map">
            <UnifiedMap
              report={report}
              overview
              defaultLightPreset={theme === 'light' ? 'day' : 'dusk'}
              focus={report ? { lat: report.lat, lon: report.lon } : null}
              onRegionSelect={(nom) => {
                setSelectedPlace(nom);
                setDiagError(null);
              }}
              weatherMetric={selectedMetric}
              weatherTime={weatherTime}
              /* Mode « risques bâtiment » (panneau ouvert) : surligner
                 l'empreinte du bâtiment diagnostiqué (extrusion 3D + pin). */
              riskHighlight={isRiskView}
              /* Projection à plat (Mercator) dès qu'une adresse est diagnostiquée :
                 les tuiles météo sont plates et l'overlay ne peut pas suivre la
                 courbure du globe 3D — on bascule en mercator dès le diagnostic
                 (les 4 cartes météo deviennent exploitables), le globe ne reste
                 que tant qu'aucune adresse n'est choisie (étape 1 « planète »). */
              flatProjection={!!report}
              /* Flood Mapping contrôle la couche inondation Géorisques (WMS
                 LIMITETRI) via visibleLayerKeys — plus les lignes Vigicrues
                 (celles-ci s'affichent via le clic « Voir » d'une alerte). */
              showFloodVigilance={false}
              alertFocus={alertFocus}
              alertMarkers={alertMarkers}
              /* Aléas Géorisques : le panneau gauche allume d'office, au
                 diagnostic, les aléas DÉTECTÉS auxquels l'adresse est exposée
                 (et pour lesquels une couche existe) ; l'utilisateur ajuste
                 ensuite via les toggles œil. S'y ajoute l'inondation forcée
                 par le toggle Flood Mapping de la console. */
              showRisks={!!report && (visibleAleas.size > 0 || floodMapping)}
              visibleLayerKeys={
                new Set([
                  ...visibleAleas,
                  /* Le toggle Flood Mapping de la console force l'aléa
                     inondation sur la carte même s'il n'est pas ouvert dans
                     le panneau (source de vérité console > panneau). */
                  ...(floodMapping ? ['inondation'] : []),
                ])
              }
              /* Enveloppe d'inondation modélisée (étape 2) — le volume d'eau
                 qui répond au scénario et à la timeline. */
              impact={riskImpact}
              journey={isRiskView ? journey : null}
              basinGeometry={isRiskView ? basinGeometry : null}
            />

          </div>
        </section>

        {/* Console météo / crues — panneau flottant en bas de l'écran.
            Avant toute adresse diagnostiquée, les 4 cartes météo sont
            affichées mais grisées (locked) avec un indice demandant de
            saisir une adresse d'abord ; elles s'activent après le
            diagnostic. */}
        <FloodConsole
          selectedMetric={selectedMetric}
          onMetricChange={setSelectedMetric}
          onTimeChange={setWeatherTime}
          locked={!report}
          /* La console n'est à l'écran qu'à l'étape 1 (escamotée, mais montée,
             à partir de l'étape 2) : la lecture s'arrête hors de l'étape 1. */
          active={step === 1}
          floodMapping={floodMapping}
          onFloodMappingChange={setFloodMapping}
        />

        {/* ===== PANNEAU D'ÉVALUATION DES RISQUES (mode « étape suivante ») —
            glisse depuis la gauche ; la carte reste à droite. ===== */}
        <RiskPanel
          place={selectedPlace}
          report={report}
          scenarioKey={scenarioKey}
          timeMin={riskTimeMin}
        />

        {/* ===== PANNEAU DES SCÉNARIOS (mode « étape suivante ») — colonne
            droite façon référence : bandeau FLOOD WARNING + SELECT SCENARIO,
            classement des scénarios probables et grille des membres. Révélé
            par CSS dans la vue risques. ===== */}
        <ScenarioPanel
          place={selectedPlace}
          report={report}
          scenarioKey={scenarioKey}
          onScenarioChange={setScenarioKey}
          timeMin={riskTimeMin}
          /* Photo terrain réelle du secteur (Panoramax) — sert de support aux
             vignettes des scénarios. null = non chargée, `available: false` =
             secteur non couvert : les deux retombent sur le visuel abstrait. */
          photo={photo}
        />

        {/* ===== CONSOLE D'ÉVALUATION DES RISQUES (mode « étape suivante ») —
            rangée basse façon référence : suivi du risque + règle temporelle.
            Montée par CSS dans la vue risques (l'écran carte garde la console
            météo FloodConsole). ===== */}
        <RiskConsole
          place={selectedPlace}
          report={report}
          scenarioKey={scenarioKey}
          timeMin={riskTimeMin}
          onTimeChange={setRiskTimeMin}
          meteo={meteo}
        />

        {/* ===== ÉTAPE 3 = la vue rapport est une page autonome (/report) ;
            un useEffect navigue directement dès que step === 3 (sans bouton). */}

      </div>

      {/* Scrim du drawer mobile */}
      <div
        className={`zone-scrim${drawerOpen ? ' visible' : ''}`}
        aria-hidden="true"
        onClick={() => setDrawerOpen(false)}
      />

    </main>
  );
}

/* ── Champ d'adresse de l'étape 1 (hero) — input natif simple ──
   Un <input type="search"> standard stylé en pilule : aucune dépendance au
   champ Material (md-outlined-text-field), donc aucune largeur intrinsèque
   qui pourrait dépasser la page. Ref, écouteurs et dropdown propres. */
function HeroAddressField({
  fieldRef,
  initialValue,
  placeholder = 'Rechercher une adresse en France…',
  suggestions,
  suggestionsOpen,
  onQueryChange,
  onHideSuggestions,
  onPick,
  onDiagnose,
  stepError,
  loading,
  error,
  shake,
}: {
  fieldRef: RefObject<HTMLInputElement | null>;
  initialValue: string;
  /** Zone sélectionnée (région ou commune) : s'affiche dans le placeholder. */
  placeholder?: string;
  suggestions: GeocodeSuggestion[];
  suggestionsOpen: boolean;
  onQueryChange: (value: string) => void;
  onHideSuggestions: () => void;
  onPick: (s: GeocodeSuggestion) => void;
  onDiagnose: (value: string) => void;
  stepError: boolean;
  loading: boolean;
  error: string | null;
  /** Secousse du champ en cas d'erreur de diagnostic. */
  shake: boolean;
}) {
  /* Écouteurs attachés au montage ; la valeur initiale restaure la dernière
     requête saisie (lastQuery) lorsque le champ est (ré)monté. */
  useEffect(() => {
    const el = fieldRef.current;
    if (!el) return;
    el.value = initialValue;
    const onInput = () => onQueryChange(el.value);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        onHideSuggestions();
        onDiagnose(el.value);
      }
    };
    const onBlur = () => window.setTimeout(onHideSuggestions, 180);
    el.addEventListener('input', onInput);
    el.addEventListener('keydown', onKey);
    el.addEventListener('blur', onBlur);
    return () => {
      el.removeEventListener('input', onInput);
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('blur', onBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handlePick(s: GeocodeSuggestion) {
    if (fieldRef.current) fieldRef.current.value = s.label;
    onPick(s);
  }

  return (
    <div
      className={`hero-pill${stepError || error ? ' hero-pill-error' : ''}${
        loading ? ' hero-pill-loading' : ''
      }${shake ? ' shake' : ''}`}
    >
      <md-icon className="hero-pill-icon" aria-hidden="true">
        search
      </md-icon>
      <label className="hero-pill-label" htmlFor="addr-input-hero">
        Rechercher une adresse
      </label>
      <input
        ref={fieldRef}
        id="addr-input-hero"
        type="search"
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        inputMode="search"
        className="hero-pill-input"
        aria-label="Rechercher une adresse"
      />
      {loading ? (
        <span className="hero-pill-spinner" aria-hidden="true" />
      ) : (
        <md-icon-button
          className="hero-send"
          aria-label="Diagnostiquer cette adresse"
          onClick={() => {
            const el = fieldRef.current;
            if (el) void onDiagnose(el.value);
          }}
        >
          <md-icon>arrow_forward</md-icon>
        </md-icon-button>
      )}
      {/* Dropdown BAN ancré à la pilule (la pilule est son conteneur relatif). */}
      {suggestionsOpen && suggestions.length > 0 && (
        <Suggestions suggestions={suggestions} onPick={handlePick} />
      )}
    </div>
  );
}
function Suggestions({
  suggestions,
  onPick,
}: {
  suggestions: GeocodeSuggestion[];
  onPick: (s: GeocodeSuggestion) => void;
}) {
  return (
    <div className="ban-suggestions">
      <md-list>
        {suggestions.map((s, i) => (
          <md-list-item
            key={i}
            onMouseDown={(e: { preventDefault: () => void }) => e.preventDefault()}
            onClick={() => onPick(s)}
          >
            <span slot="headline">{s.label}</span>
            {s.context ? <span slot="supporting-text">{s.context}</span> : null}
          </md-list-item>
        ))}
      </md-list>
    </div>
  );
}

/* La sidenav (ZoneSidenav + ConversationHistory + useIsMobile) vit dans
   ../components/ZoneSidenav — partagée entre /zone et /settings. */

/* ── Chip d'étape : indique « étape N / total » + pastilles de progression,
   à gauche du bouton « étape suivante ». Les pastilles passées se teintent,
   l'actuelle est surlignée ; le compteur se met à jour en douceur. ── */
function StepChip({ step, total, locked = false }: { step: number; total: number; locked?: boolean }) {
  return (
    <div
      className={`step-chip${locked ? ' is-locked' : ''}`}
      aria-label={
        locked
          ? `Étape ${step} sur ${total} — étapes suivantes indisponibles sans adresse`
          : `Étape ${step} sur ${total}`
      }
    >
      <span className="step-chip-title">Étape</span>
      <span className="step-dots" aria-hidden="true">
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className={`step-dot${i + 1 < step ? ' done' : ''}${i + 1 === step ? ' cur' : ''}${
              // Sans adresse, les étapes à venir sont marquées « à venir » plutôt
              // que neutres : la pastille dit ce qui manque, pas seulement où on est.
              locked && i + 1 > step ? ' todo' : ''
            }`}
          />
        ))}
      </span>
      <span className="step-chip-count">
        <b>{step}</b>
        <i>/</i>
        {total}
      </span>
    </div>
  );
}