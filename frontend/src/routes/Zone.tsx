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

import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { UnifiedMap } from '../components/UnifiedMap';
import { ZoneSidenav, useIsMobile } from '../components/ZoneSidenav';
import { FloodConsole } from '../components/FloodConsole';
import { LeftPanels } from '../components/LeftPanels';
import { RightAlertsPanel } from '../components/RightAlertsPanel';
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
  const [selectedMetric, setSelectedMetric] = useState('wind');

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
      }`}
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
        <LeftPanels />
        {/* ===== PANNEAU DROIT — alertes de la zone / portefeuille ===== */}
        <RightAlertsPanel />
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
          />
          <button
            type="button"
            className="sim-indicator"
            aria-label="Lancer une simulation"
            title="Lancer une simulation"
          >
            <md-icon aria-hidden="true">add</md-icon>
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
              report={null}
              overview
              defaultLightPreset={theme === 'light' ? 'day' : 'night'}
              focus={report ? { lat: report.lat, lon: report.lon } : null}
              onRegionSelect={(nom) => {
                setSelectedPlace(nom);
                setDiagError(null);
              }}
              showWind={selectedMetric === 'wind'}
            />
          </div>
        </section>

        {/* Console météo / crues — panneau flottant en bas de l'écran */}
        <FloodConsole selectedMetric={selectedMetric} onMetricChange={setSelectedMetric} />

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