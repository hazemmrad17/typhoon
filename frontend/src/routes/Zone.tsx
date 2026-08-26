// =============================================================================
//   TYPHOON — /zone : diagnostic géo-risque par adresse (Stepper Material 3)
//     1. Adresse         — hero centré façon Gemini (champ de recherche au centre)
//     2. Cartographie    — aléas & risques (panneau latéral rétractable) + carte unifiée
//     3. Analyse         — fiche bâtiment BDNB (panneau latéral rétractable) + carte unifiée
//     4. Recommandations — recommandations détaillées
//     5. Artisans        — professionnels associés aux travaux
//
//   Le contrat servi est le DiagnosticRecord canonique (POST /diagnostic/adresse),
//   adapté en vue historique via zone/canonicalAdapter. Pas de score, pas de
//   narration IA, pas de Copernicus (constitution §2).
//
//   Stepper linéaire : les étapes 2-5 sont bloquées tant qu'aucune adresse
//   n'a été diagnostiquée — l'étape Adresse passe en état d'erreur (icône
//   erreur + message) si l'on tente de les atteindre sans rapport.
// =============================================================================

import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { UnifiedMap } from '../components/UnifiedMap';
import { BuildingFiche } from '../components/BuildingFiche';
import { ZoneRecommendations } from '../components/ZoneRecommendations';
import { ZoneArtisans } from '../components/ZoneArtisans';
import { ZoneSidenav, useIsMobile } from '../components/ZoneSidenav';
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
  ALEA_ICONS,
  ALEA_ICON_FALLBACK,
  escHtml,
  type AleaDetail,
  type BatimentRisques,
  type GeocodeSuggestion,
  type RisqueReport,
} from '../zone/config';
import type { RecommendationZone } from '../zone/recommendations';
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
import '../styles/zone.css';


/* ── Multi-profils (Phase A) : ordre du stepper par profil.
   Le promoteur reste la vue par défaut et ne voit AUCUNE différence — seul
   l'ordre/la visibilité des étapes change pour l'assurance et la banque.
   Les étapes « copernicus » et « rapport IA » sont supprimées (constitution §2). */
const STEP_ORDER: Record<string, string[]> = {
  promoteur: ['adresse', 'carto', 'analyse', 'recommandations', 'artisans'],
  assurance: ['adresse', 'analyse', 'decision'],
  banque: ['adresse', 'carto', 'analyse'],
};

/* Libellés du stepper par étape logique (le promoteur garde ses libellés actuels). */
const STEP_LABELS: Record<string, string> = {
  adresse: 'Adresse',
  carto: 'Cartographie',
  decision: 'Synthèse',
  analyse: 'Bien & contexte',
  recommandations: 'Recommandations',
  artisans: 'Artisans',
};

export function Zone() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { theme, accent, mode, setThemeMode } = useTyphoonTheme();
  const { profile } = useUserProfile();
  const { signOut } = useAuth();
  const isMobile = useIsMobile();
  /* Sidenav repliée par défaut : dépliée uniquement quand elle est épinglée
     (toggle) ou pendant le survol (peek, voir ZoneSidenav). */
  const [navCollapsed, setNavCollapsed] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const sidenavRef = useRef<HTMLElement | null>(null);

  /* Ouverture du drawer mobile : amener le focus dans la navigation. */
  useEffect(() => {
    if (!isMobile || !drawerOpen) return;
    const first = sidenavRef.current?.querySelector<HTMLElement>(
      'a, [tabindex]:not([tabindex="-1"])'
    );
    first?.focus();
  }, [isMobile, drawerOpen]);

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

  const [step, setStep] = useState(0);
  const [stepError, setStepError] = useState(false);
  const [suggestions, setSuggestions] = useState<GeocodeSuggestion[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [diagError, setDiagError] = useState<string | null>(null);
  const [report, setReport] = useState<RisqueReport | null>(null);
  const [detailedRecommendationZones, setDetailedRecommendationZones] = useState<Record<string, RecommendationZone>>({});
  const [detailedRecommendationsLoading, setDetailedRecommendationsLoading] = useState(false);
  const [detailedRecommendationsError, setDetailedRecommendationsError] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [, setConversations] = useState<Conversation[]>(() => loadConversations());
  /* Panneau latéral (aléas ou fiche) rétractable : replié → carte plein écran. */
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  /* Moteur de carte : Mapbox GL JS (unique, pas de fallback MapLibre). */
  const [visibleLayerKeys, setVisibleLayerKeys] = useState<ReadonlySet<string>>(new Set());
  /* Niveaux de risque bâtiment (argile/radon/sismique — table BDNB
     `batiment_groupe_risques`, story D2) du bâtiment diagnostiqué : alimente
     la section Risques de la fiche BDNB et le mode carte « Risques bâtiment ». */
  const [batimentRisques, setBatimentRisques] = useState<BatimentRisques | null>(null);
  const [, setCatNatLatest] = useState<Record<string, number>>(() => loadCatNatLatest());

  useEffect(() => {
    const id = report?.bdnb?.batiment?.batiment_groupe_id;
    if (!id) { setBatimentRisques(null); return; }
    let cancelled = false;
    setBatimentRisques(null);
    (async () => {
      try {
        const resp = await fetch(`${API}/diagnostic/zone/building?id=${encodeURIComponent(id)}`);
        if (!resp.ok || cancelled) return;
        const fiche = await resp.json();
        if (!cancelled) setBatimentRisques(fiche?.risques ?? null);
      } catch {
        // Non bloquant : la fiche/carte restent exploitables sans les risques bâtiment.
      }
    })();
    return () => { cancelled = true; };
  }, [report?.bdnb?.batiment?.batiment_groupe_id]);

  /* Champ de la topbar (étapes 2-4) et champ du hero (étape 1) : deux
     instances distinctes de md-outlined-text-field, chacune avec son ref. */
  const inputRef = useRef<HTMLElement & { value: string }>(null);
  const heroInputRef = useRef<HTMLInputElement>(null);
  const lastQuery = useRef('');
  const banTimeout = useRef<number | null>(null);
  const recommendationsRequestId = useRef(0);

  async function loadDetailedRecommendations(_address: string) {
    const requestId = ++recommendationsRequestId.current;
    setDetailedRecommendationsLoading(true);
    setDetailedRecommendationsError(null);
    setDetailedRecommendationZones({});
    try {
      /* Recommandations détaillées : source retirée avec Copernicus (OQ-4). */
      setDetailedRecommendationsError('Recommandations détaillées non disponibles (en cours de réécriture).');
    } catch (error) {
      if (requestId !== recommendationsRequestId.current) return;
      setDetailedRecommendationsError(error instanceof Error ? error.message : 'Recommandations détaillées indisponibles');
    } finally {
      if (requestId === recommendationsRequestId.current) setDetailedRecommendationsLoading(false);
    }
  }

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
    setStepError(false); // l'erreur « adresse manquante » se dissipe dès la saisie
    setDiagError(null); // l'erreur d'API se dissipe aussi dès la saisie
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
  }

  /* ── Diagnostic ──  Le cache local (façon « historique ChatGPT ») sert la
     même adresse instantanément sans refetch ; un bouton « rafraîchir »
     force un appel réseau (voir handleRefresh). */
  async function runDiagnosis(q: string, opts: { force?: boolean } = {}) {
    const value = q.trim();
    if (!value) {
      setDiagError('Saisissez une adresse.');
      return;
    }
    hideSuggestions();
    setDiagError(null);

    /* Cache local : si l'adresse a déjà été diagnostiquée (et est encore
       fraîche), on restitue le rapport complet sans aucun appel réseau. */
    if (!opts.force) {
      const cached = getCachedDiagnostic(value);
      if (cached) {
        setReport(cached.report);
        setFromCache(true);
        setConversations((prev) => {
          const next = addConversation(prev, cached.report.adresse_normalisee || value);
          saveConversations(next);
          return next;
        });
        setStepError(false);
        setStep(1); // → étape Cartographie (aléas + carte unifiée)
        setVisibleLayerKeys(
          new Set(
            (cached.report.aleas || [])
              .filter((a) => a.present !== null)
              .map((a) => a.code)
          )
        );
        return;
      }
    }

    setLoading(true);
    if (!opts.force) {
      /* Nouveau diagnostic : on nettoie l'ancien état pendant le chargement. */
      setReport(null);
      setFromCache(false);
    }
    /* Rafraîchissement forcé : on laisse le rapport actuel en place pendant
       le chargement — remplacé seulement en cas de succès. */
    recommendationsRequestId.current += 1;
    setDetailedRecommendationZones({});
    setDetailedRecommendationsLoading(false);
    setDetailedRecommendationsError(null);

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
      void loadDetailedRecommendations(view.adresse_normalisee || value);
      setFromCache(false); // données fraîches du réseau → badge « en cache » retiré
      putCachedDiagnostic(view); // sauvegarde le résultat pour les prochains passages
      /* Historique « Récent » (localStorage). */
      setConversations((prev) => {
        const next = addConversation(prev, view.adresse_normalisee || value);
        saveConversations(next);
        return next;
      });
      setStepError(false); // l'adresse est validée → étapes suivantes débloquées
      setStep(1); // → étape Cartographie (aléas + carte unifiée)
      setVisibleLayerKeys(
        new Set((view.aleas || []).filter((a) => a.present !== null).map((a) => a.code))
      );
    } catch {
      setDiagError('Erreur réseau — backend inaccessible ?');
    } finally {
      setLoading(false);
    }
  }

  /* Rafraîchissement forcé : ignore le cache et relance le diagnostic réseau. */
  function handleRefresh() {
    if (!report) return;
    void runDiagnosis(report.adresse_normalisee || report.adresse_saisie, { force: true });
  }

  /* ── Navigation du stepper (linéaire : impossible de sauter l'adresse) ── */
  function goToStep(i: number) {
    if (i > 0 && !report) {
      setStepError(true); // étape Adresse → état d'erreur, navigation bloquée
      setDiagError(null); // le message du stepper prime sur une erreur d'API antérieure
      window.setTimeout(() => heroInputRef.current?.focus(), 80);
      return;
    }
    setStepError(false);
    setStep(i);
    if (i === 0) window.setTimeout(() => heroInputRef.current?.focus(), 80);
  }

  /* ── Visibilité des couches ── */
  function toggleLayer(code: string) {
    setVisibleLayerKeys((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  function setAllVisible(visible: boolean) {
    if (!report) return;
    /* Tous les aléas à source disponible (présents ou absents) ont une couche
       affichable sur la carte — les absents montrent la donnée communale.
       Seuls les aléas à source indisponible (present=null) n'ont rien à
       afficher et restent hors de la sélection. */
    const codes = togglableAleas.map((a) => a.code);
    setVisibleLayerKeys(visible ? new Set(codes) : new Set());
  }

  /* ── Multi-profils : étapes visibles pour le profil courant ──
     L'index d'une étape est sa POSITION dans l'ordre du profil ; les rendus
     ci-dessous testent l'ID de l'étape courante (currentStepId), jamais la
     position brute — chaque profil peut donc réordonner librement ses étapes
     (l'assurance est volontairement Adresse → Bien & contexte → Synthèse). */
  const profileSteps = (STEP_ORDER[profile] || STEP_ORDER.promoteur).map((id, i) => ({
    id,
    label: STEP_LABELS[id] ?? id,
    index: i,
  }));
  const currentStepId = profileSteps[step]?.id ?? 'adresse';
  /* Étapes qui embarquent la carte unifiée (panneau latéral + carte). */
  const isMapStep = ['carto', 'analyse', 'decision'].includes(currentStepId);

  /* ── Dérivés du rapport ── */
  /* Aléas dont la source est disponible (présents OU absents) : les absents
     restent visualisables sur la carte via les couches communales WMS/WFS. */
  const togglableAleas = (report?.aleas || []).filter((a) => a.present !== null);

  const catnat = (report?.aleas || []).flatMap((a) =>
    (a.catnat_historique || []).map((ev) => ({
      ...ev,
      alea_libelle: a.libelle,
    }))
  );

  /* « Tout masquer » n'est affiché que si TOUS les aléas à source disponible
     sont visibles — c'est ce que la carte peut réellement montrer. */
  const allTogglableVisible =
    report !== null &&
    togglableAleas.length > 0 &&
    togglableAleas.every((a) => visibleLayerKeys.has(a.code));

  /* ── Cartographie & Synthèse : couches visibles dès l'arrivée ──
     Toutes les couches disponibles passent visibles automatiquement, une
     seule fois par rapport ; les toggles manuels reprennent ensuite la main. */
  const autoShownReportRef = useRef<string | null>(null);
  useEffect(() => {
    if ((currentStepId !== 'carto' && currentStepId !== 'decision') || !report) return;
    const key = `${report.adresse_normalisee}::${report.date_generation}`;
    if (autoShownReportRef.current === key) return;
    autoShownReportRef.current = key;
    const codes = (report.aleas || [])
      .filter((a) => a.present !== null)
      .map((a) => a.code);
    if (codes.length) setVisibleLayerKeys(new Set(codes));
  }, [currentStepId, report]);

  const pdfUrl = report
    ? `${API}/diagnostic/adresse/rapport-pdf?lat=${report.lat}&lon=${report.lon}`
    : '#';

  return (
    <main
      className={`zone-app${theme === 'light' ? ' theme-light' : ''}${
        panelCollapsed ? ' panel-collapsed' : ''
      }${navCollapsed && !isMobile ? ' nav-collapsed' : ''}${drawerOpen ? ' drawer-open' : ''}`}
      style={{ '--accent': accent } as CSSProperties}
    >
      {/* ===== SIDENAV rétractable (navigation façon Gemini) ===== */}
      <ZoneSidenav
        sidenavRef={sidenavRef}
        collapsed={navCollapsed && !isMobile}
        mobile={isMobile}
        hidden={isMobile && !drawerOpen}
        theme={theme}
        mode={mode}
        onThemeModeChange={setThemeMode}
        onToggleCollapse={() =>
          isMobile ? setDrawerOpen(false) : setNavCollapsed((c) => !c)
        }
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
        onNewDiagnostic={() => {
          setDrawerOpen(false);
          goToStep(0);
        }}
        onNavigate={(path) => {
          setDrawerOpen(false);
          navigate(path);
        }}
        profile={profile}
        activePath={location.pathname}
      />

      {/* ===== COLONNE PRINCIPALE ===== */}
      <div className="zone-main">
        {/* ===== STEPPER (indicateur d'étapes, linéaire) ===== */}
        <nav className="zone-stepper" aria-label="Étapes du diagnostic">
          <md-icon-button
            className="sidenav-hamburger"
            aria-label="Ouvrir le menu"
            onClick={() => setDrawerOpen(true)}
          >
            <md-icon>menu</md-icon>
          </md-icon-button>
          {profileSteps.map((s, i) => {
          const active = s.index === step;
          const done = s.index < step;
          const isError = s.index === 0 && stepError;
          return (
            <div className="step-segment" key={s.id}>
              <button
                type="button"
                className={`step-item${active ? ' active' : ''}${done ? ' done' : ''}${
                  isError ? ' error' : ''
                }`}
                aria-current={active ? 'step' : undefined}
                aria-invalid={isError || undefined}
                onClick={() => goToStep(s.index)}
              >
                <span className="step-dot">
                  {isError ? (
                    <md-icon>error</md-icon>
                  ) : done ? (
                    <md-icon>check</md-icon>
                  ) : (
                    <span>{i + 1}</span>
                  )}
                </span>
                <span className="step-label">{s.label}</span>
              </button>
              {i < profileSteps.length - 1 && (
                <span className={`step-connector${done ? ' done' : ''}`} aria-hidden="true" />
              )}
            </div>
          );
          })}
        </nav>

        {/* ===== ÉTAPE 1 — ADRESSE (hero façon Gemini) ===== */}
      {step === 0 && (
        <section className="zone-hero">
          <div className="hero-brand">
            <h1>Diagnostic géo-risque</h1>
          </div>

          <div className="hero-search">
            <div className="input-wrap">
              <div className={`hero-field${stepError || diagError ? ' shake' : ''}`}>
                <HeroAddressField
                  fieldRef={heroInputRef}
                  initialValue={lastQuery.current}
                  suggestions={suggestions}
                  suggestionsOpen={suggestionsOpen}
                  onQueryChange={onQueryChange}
                  onHideSuggestions={hideSuggestions}
                  onPick={pickSuggestion}
                  onDiagnose={(v) => void runDiagnosis(v)}
                  stepError={stepError}
                  loading={loading}
                  error={diagError}
                />
              </div>
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
                (stepError || diagError) && (
                  <div className="hero-error" role="alert">
                    <md-icon>error</md-icon>
                    <span>
                      {diagError ||
                        "Saisissez d'abord une adresse pour accéder aux étapes suivantes."}
                    </span>
                  </div>
                )
              )}
            </div>
            {!loading && (
              <div className="hero-hints">
                <span>ex. 14 Avenue des Palmiers 06000 Nice</span>
                <span>Entrée ↵ pour diagnostiquer</span>
              </div>
            )}
          </div>
        </section>
      )}

      {/* ===== ÉTAPES 2–5 : topbar + scène ===== */}
      {step >= 1 && (
        <>
          <header className="zone-topbar">
            <div className="topbar-main">
              <div className="topbar-search">
                <div className="input-wrap">
                  <AddressField
                    id="addr-input"
                    fieldRef={inputRef}
                    initialValue={lastQuery.current}
                    suggestions={suggestions}
                    suggestionsOpen={suggestionsOpen}
                    onQueryChange={onQueryChange}
                    onHideSuggestions={hideSuggestions}
                    onPick={pickSuggestion}
                    onDiagnose={(v) => void runDiagnosis(v)}
                  >
                    <md-icon slot="leading-icon">search</md-icon>
                  </AddressField>
                </div>
              </div>

            </div>
          </header>

          <div className={`zone-stage${isMapStep ? ' workspace' : ' flat'}`}>
            {/* ÉTAPES AVEC CARTE — panneau latéral + carte unifiée */}
            <div className="zone-merge" hidden={!isMapStep}>
              {/* PANNEAU LATÉRAL (rétractable) — contenu selon l'étape */}
              <aside className="zone-merge-left">
                <md-icon-button
                  className="panel-collapse-btn"
                  aria-label="Réduire le panneau"
                  title="Réduire le panneau (carte plein écran)"
                  onClick={() => setPanelCollapsed(true)}
                >
                  <md-icon>chevron_left</md-icon>
                </md-icon-button>
                <div className="zone-panel-body">
                  {report ? (
                    currentStepId === 'analyse' ? (
                      <BuildingFiche report={report} risques={batimentRisques} />
                    ) : currentStepId === 'decision' || currentStepId === 'carto' ? (
                  <section className="zone-results">
                    <div className="addr-heading">
                      <div className="addr-title-row">
                        <div className="norm">{report.adresse_normalisee}</div>
                        <div className="addr-actions">
                          {fromCache && (
                            <span className="cache-badge" title="Résultat servi depuis le cache local — données Géorisques enregistrées lors du dernier diagnostic.">
                              <md-icon>database</md-icon> en cache
                            </span>
                          )}
                          <md-icon-button
                            className="refresh-btn"
                            aria-label="Rafraîchir le diagnostic"
                            title="Rafraîchir les données (nouvel appel Géorisques)"
                            aria-busy={loading || undefined}
                            disabled={loading}
                            onClick={handleRefresh}
                          >
                            <md-icon>refresh</md-icon>
                          </md-icon-button>
                        </div>
                      </div>
                      <div className="meta">
                        GPS {report.lat.toFixed(5)}°N, {report.lon.toFixed(5)}°E · Code INSEE{' '}
                        {report.code_insee} · Généré le {report.date_generation}
                      </div>
                    </div>

                    <div className="aleas-section">
                      <div className="section-heading">
                        <span>Aléas recensés — Géorisques</span>
                        <md-text-button
                          className="toggle-all"
                          aria-label={
                            allTogglableVisible
                              ? 'Masquer toutes les couches sur la carte'
                              : 'Afficher toutes les couches sur la carte'
                          }
                          onClick={() => setAllVisible(!allTogglableVisible)}
                        >
                          <md-icon slot="icon">
                            {allTogglableVisible ? 'visibility' : 'visibility_off'}
                          </md-icon>
                          {allTogglableVisible ? 'Tout masquer' : 'Tout afficher'}
                        </md-text-button>
                      </div>
                      <div className="alea-scope-hint" role="note">
                        « À votre adresse » : risque détecté sur le bien · « Dans la commune » : risque recensé au niveau communal
                      </div>
                      <div className="alea-cards">
                        {(report.aleas || []).map((a) => (
                          <AleaCard
                            key={a.code}
                            alea={a}
                            visible={visibleLayerKeys.has(a.code)}
                            onToggle={() => toggleLayer(a.code)}
                          />
                        ))}
                      </div>
                    </div>

                    {catnat.length > 0 && (
                      <details className="catnat-section">
                        <summary className="section-heading catnat-summary">
                          <span>
                            Historique arrêtés CatNat{' '}
                            <span className="catnat-count">({catnat.length} arrêtés)</span>
                          </span>
                          <md-icon>expand_more</md-icon>
                        </summary>
                        <md-list className="catnat-list">
                          {catnat.slice(0, 15).map((ev, i) => (
                            <md-list-item key={i}>
                              <md-icon slot="start">history</md-icon>
                              <span slot="headline">
                                {ev.libelle_risque_jo || ev.libelle || '—'}
                              </span>
                              {ev.date_debut_evt ? (
                                <span slot="supporting-text">
                                  {ev.date_debut_evt.length >= 10
                                    ? ev.date_debut_evt.slice(0, 10)
                                    : ev.date_debut_evt}
                                </span>
                              ) : null}
                            </md-list-item>
                          ))}
                          {catnat.length > 15 && (
                            <md-list-item>
                              <span slot="headline">+ {catnat.length - 15} autre(s)…</span>
                            </md-list-item>
                          )}
                        </md-list>
                      </details>
                    )}

                    {report.erreurs_partielles?.length > 0 && (
                      <div className="partial-banner">
                        <md-icon>warning</md-icon>
                        <span>
                          <strong>Sources partiellement indisponibles :</strong>{' '}
                          {escHtml(report.erreurs_partielles.join(' · '))}. Les aléas concernés
                          affichent « source indisponible ».
                        </span>
                      </div>
                    )}

                    <div className="avertissement">
                      <md-icon>info</md-icon>
                      <span>
                        <strong>⚠ Ce rapport n'est pas l'ERRIAL officiel.</strong> Il agrège les
                        données publiques Géorisques (BRGM / MTE). Il ne remplace pas l'État des
                        Risques réglementaire obligatoire à la vente/location.
                      </span>
                    </div>
                  </section>
                    ) : null
                  ) : (
                    <div className="sidebar-empty">
                      <md-icon>gps_fixed</md-icon>
                      <p>Recherchez une adresse pour afficher le diagnostic géo-risque.</p>
                    </div>
                  )}
                </div>
              </aside>                {/* CARTE UNIFIÉE — Mapbox GL JS · bâti BDNB 3D, satellite,
                    parcelles, aléas, montée des eaux */}
              <section className="zone-merge-map">
                {panelCollapsed && (
                  <md-icon-button
                    className="panel-expand-btn"
                    aria-label="Agrandir le panneau"
                    title="Agrandir le panneau"
                    onClick={() => setPanelCollapsed(false)}
                  >
                    <md-icon>chevron_right</md-icon>
                  </md-icon-button>
                )}
                  <UnifiedMap
                    report={report}
                    visibleLayerKeys={visibleLayerKeys}
                    batimentRisques={batimentRisques}
                    showRisks={currentStepId === 'carto' || currentStepId === 'decision'}
                    allowParcels={currentStepId === 'analyse'}
                    /* Parcelles ON + éclairage « jour » à l'arrivée sur « Bien &
                       contexte » ; Parcelles OFF dès qu'on passe à « Synthèse »
                       (et aux étapes suivantes). */
                    defaultParcels={currentStepId === 'analyse'}
                    defaultLightPreset={currentStepId === 'analyse' ? 'day' : undefined}
                    buildingsLimit={currentStepId === 'carto' || currentStepId === 'decision' ? 500 : 200}
                    fitZoom={16.5}
                  />
              </section>
            </div>

            {/* ÉTAPE — RECOMMANDATIONS (détaillées, RAG Mistral) */}
            <section className="zone-recommendations" hidden={currentStepId !== 'recommandations'}>
              <ZoneRecommendations
                report={report}
                zones={detailedRecommendationZones}
                loading={detailedRecommendationsLoading}
                error={detailedRecommendationsError}
              />
            </section>

            {/* ÉTAPE 5 — ARTISANS (associés aux travaux recommandés) */}
            <section className="zone-artisans-step" hidden={currentStepId !== 'artisans'}>
              <ZoneArtisans
                report={report}
                zones={detailedRecommendationZones}
                loading={detailedRecommendationsLoading}
                error={detailedRecommendationsError}
              />
            </section>

          </div>
        </>
      )}
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
  suggestions,
  suggestionsOpen,
  onQueryChange,
  onHideSuggestions,
  onPick,
  onDiagnose,
  stepError,
  loading,
  error,
}: {
  fieldRef: RefObject<HTMLInputElement | null>;
  initialValue: string;
  suggestions: GeocodeSuggestion[];
  suggestionsOpen: boolean;
  onQueryChange: (value: string) => void;
  onHideSuggestions: () => void;
  onPick: (s: GeocodeSuggestion) => void;
  onDiagnose: (value: string) => void;
  stepError: boolean;
  loading: boolean;
  error: string | null;
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
    <>
      <div
        className={`hero-pill${stepError || error ? ' hero-pill-error' : ''}${
          loading ? ' hero-pill-loading' : ''
        }`}
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
          placeholder="Rechercher une adresse en France…"
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
      </div>
      {suggestionsOpen && suggestions.length > 0 && (
        <Suggestions suggestions={suggestions} onPick={handlePick} />
      )}
    </>
  );
}

/* ── Champ d'adresse réutilisable (topbar) ──
   Chaque instance possède son propre md-outlined-text-field (ref distincte),
   ses écouteurs (autocomplétion BAN, Entrée) et son dropdown de suggestions. */
function AddressField({
  id,
  fieldRef,
  initialValue,
  suggestions,
  suggestionsOpen,
  onQueryChange,
  onHideSuggestions,
  onPick,
  onDiagnose,
  children,
}: {
  id: string;
  fieldRef: RefObject<HTMLElement & { value: string } | null>;
  initialValue: string;
  suggestions: GeocodeSuggestion[];
  suggestionsOpen: boolean;
  onQueryChange: (value: string) => void;
  onHideSuggestions: () => void;
  onPick: (s: GeocodeSuggestion) => void;
  onDiagnose: (value: string) => void;
  children?: ReactNode;
}) {
  /* Écouteurs attachés au montage : la valeur initiale restaure la dernière
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
    <>
      <md-outlined-text-field
        ref={fieldRef}
        id={id}
        type="search"
        placeholder="Rechercher une adresse en France…"
        label="Rechercher une adresse"
        autoComplete="off"
        spellCheck={false}
        inputMode="search"
      >
        {children}
      </md-outlined-text-field>
      {suggestionsOpen && suggestions.length > 0 && (
        <Suggestions suggestions={suggestions} onPick={handlePick} />
      )}
    </>
  );
}

/* ── Suggestions BAN (dropdown) ── */
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

/* ── Carte d'aléa ── */
const RESOLUTION_BADGES: Record<string, { label: string; cls: string; title: string }> = {
  'per-building': {
    label: 'Au bâtiment',
    cls: 'chip-on',
    title: 'Vérifié par test géométrique (polygone WFS) sur cette parcelle.',
  },
  'commune-level': {
    label: 'Commune (décret)',
    cls: 'chip-mid',
    title: 'Zonage décrétal communal par nature — pas de résolution plus fine possible.',
  },
  'commune-level-estimate': {
    label: 'Estimation communale',
    cls: 'chip-mid',
    title: 'Commune recensée ; pas de vérification à l\'adresse (source vectorielle indisponible).',
  },
};

function AleaCard({
  alea,
  visible,
  onToggle,
}: {
  alea: AleaDetail;
  visible: boolean;
  onToggle: () => void;
}) {
  const icon = ALEA_ICONS[alea.code] || ALEA_ICON_FALLBACK;
  const isError = alea.present === null;

  const addrPresent = alea.present === true;
  const communePresent = alea.present_commune === true;
  /* « Tous les risques par défaut » : dès qu'un recensement existe (à
     l'adresse OU dans la commune), la carte présente le péril comme un
     risque — « Pas de risque » n'est plus l'état principal quand la commune
     recense l'aléa. La portée exacte (adresse vs commune) reste en chip
     secondaire, et seule l'absence totale de recensement atténue la carte. */
  const isAbsent = !addrPresent && !communePresent;

  const primaryStatus = addrPresent
    ? { label: 'Concerné', cls: 'chip-on' }
    : communePresent
      ? { label: 'Commune : risque existant', cls: 'chip-mid' }
      : { label: 'Pas de risque', cls: 'chip-none' };
  const secondaryStatus = addrPresent
    ? communePresent
      ? null
      : { label: 'Commune : non concerné', cls: 'chip-none' }
    : communePresent
      ? { label: "Pas de risque à l'adresse", cls: 'chip-none' }
      : null;
  const resolutionBadge = RESOLUTION_BADGES[alea.resolution ?? ''] ?? null;
  /* L'œil est actif dès que la source est disponible (présent OU absent) :
     un aléa non présent reste visualisable via la couche communale WMS/WFS.
     Seule une source indisponible (present=null) n'a rien à montrer. */
  const canToggle = alea.present !== null;

  return (
    <div className={`alea-card${isAbsent ? ' absent' : ''}${isError ? ' error-partial' : ''}`}>
      <div className="alea-head">
        <span className="alea-icon">
          <md-icon>{icon}</md-icon>
        </span>
        <span className="alea-name">{alea.libelle}</span>
        {resolutionBadge ? (
          <span
            className={`d03-pill ${resolutionBadge.cls}`}
            title={resolutionBadge.title}
          >
            {resolutionBadge.label}
          </span>
        ) : null}
        <md-icon-button
          className="eye-btn"
          aria-label={
            canToggle
              ? visible
                ? `Masquer la couche ${alea.libelle} sur la carte`
                : `Afficher la couche ${alea.libelle} sur la carte`
              : `Aucune couche à afficher pour ${alea.libelle}`
          }
          title={
            canToggle
              ? alea.present === true
                ? visible
                  ? `Masquer la couche ${alea.libelle} sur la carte`
                  : `Afficher la couche ${alea.libelle} sur la carte`
                : visible
                  ? `Masquer la couche ${alea.libelle} (risque non présent à l'adresse, donnée communale)`
                  : `Afficher la couche ${alea.libelle} (risque non présent à l'adresse, donnée communale)`
              : 'Source indisponible — aucune couche à afficher'
          }
          disabled={!canToggle}
          onClick={onToggle}
        >
          <md-icon>{visible ? 'visibility' : 'visibility_off'}</md-icon>
        </md-icon-button>
      </div>

      <div className="alea-body">
        {alea.zonage ? <span className="alea-zonage">{alea.zonage}</span> : null}
        <div className="alea-statuses">
          {isError ? (
            <span className="status-chip chip-off">
              <md-icon>cloud_off</md-icon> Source indisponible
            </span>
          ) : (
            <>
              <span className={`status-chip ${primaryStatus.cls}`}>
                <span className="status-dot" aria-hidden="true" />
                {primaryStatus.label}
              </span>
              {secondaryStatus && (
                <span className={`status-chip ${secondaryStatus.cls}`}>
                  <span className="status-dot" aria-hidden="true" />
                  {secondaryStatus.label}
                </span>
              )}
            </>
          )}
        </div>
        {alea.url_detail ? (
          <a className="alea-link" href={alea.url_detail} target="_blank" rel="noopener">
            <md-icon>open_in_new</md-icon>
          </a>
        ) : null}
      </div>
    </div>
  );
}

/* La sidenav (ZoneSidenav + ConversationHistory + useIsMobile) vit dans
   ../components/ZoneSidenav — partagée entre /zone et /settings. */
