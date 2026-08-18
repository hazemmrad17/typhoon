// =============================================================================
//   TYPHOON — /zone : diagnostic géo-risque par adresse (Stepper Material 3)
//     1. Adresse         — hero centré façon Gemini (champ de recherche au centre)
//     2. Cartographie    — aléas & risques (panneau latéral rétractable) + carte unifiée
//     3. Analyse         — fiche bâtiment BDNB (panneau latéral rétractable) + carte unifiée
//     4. Recommandations — recommandations détaillées (RAG Mistral)
//     5. Artisans        — professionnels associés aux travaux
//     6. Rapport IA      — rapport narratif Mistral + export PDF
//
//   Stepper linéaire : les étapes 2-6 sont bloquées tant qu'aucune adresse
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
import { CopernicusPanel } from '../components/CopernicusPanel';
import {
  loadCatNatLatest,
  recordCatNatLatest,
  saveCatNatLatest,
} from '../zone/watchlist';
import {
  API,
  D03,
  ALEA_ICONS,
  ALEA_ICON_FALLBACK,
  bandForKey,
  escHtml,
  aleaScore,
  type AleaDetail,
  type BatimentRisques,
  type RisqueReport,
  type RapportNarratif,
  type GeocodeSuggestion,
  type Trajectoire,
} from '../zone/config';
import type { RecommendationZone } from '../jumeau/recommendations';
import {
  addConversation,
  loadConversations,
  saveConversations,
  type Conversation,
} from '../zone/conversations';
import {
  getCachedDiagnostic,
  putCachedDiagnostic,
  putCachedRapport,
  putCachedTrajectoire,
} from '../zone/diagnosticCache';
import '../styles/zone.css';


/* ── Multi-profils (Phase A) : ordre du stepper par profil.
   Le promoteur reste la vue par défaut et ne voit AUCUNE différence — seul
   l'ordre/la visibilité des étapes change pour l'assurance et la banque. */
const STEP_ORDER: Record<string, string[]> = {
  promoteur: ['adresse', 'carto', 'analyse', 'recommandations', 'artisans', 'rapport'],
  assurance: ['adresse', 'analyse', 'decision', 'copernicus', 'rapport'],
  banque: ['adresse', 'carto', 'analyse', 'rapport'],
};

/* Libellés du stepper par étape logique (le promoteur garde ses libellés actuels). */
const STEP_LABELS: Record<string, string> = {
  adresse: 'Adresse',
  carto: 'Cartographie',
  decision: 'Synthèse',
  analyse: 'Bien & contexte',
  copernicus: 'Projection climatique',
  recommandations: 'Recommandations',
  artisans: 'Artisans',
  rapport: 'Rapport IA',
};

/* Erreur structurée du rapport IA — contrat backend /diagnostic/adresse/rapport :
   { error: <code>, detail: <message utilisateur>, cause: <cause technique> } */
interface RapportError {
  code: string; // mistral_api_key_manquante | mistral_indisponible | reseau | http_*
  status?: number;
  message: string; // message lisible
  hint?: string; // conseil actionnable (facultatif)
  cause?: string; // détail technique (affiché dans <details>)
}

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
  const [rapport, setRapport] = useState<RapportNarratif | null>(null);
  const [rapportLoading, setRapportLoading] = useState(false);
  const [rapportError, setRapportError] = useState<RapportError | null>(null);
  /* Export PDF du rapport IA (jsPDF côté client) — vrai bouton de téléchargement. */
  const [exportingPdf, setExportingPdf] = useState(false);
  const [exportPdfError, setExportPdfError] = useState<string | null>(null);
  /* Panneau latéral (aléas ou fiche) rétractable : replié → carte plein écran. */
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  /* Moteur de carte : Mapbox GL JS (unique, pas de fallback MapLibre). */
  const [visibleLayerKeys, setVisibleLayerKeys] = useState<ReadonlySet<string>>(new Set());
  /* Niveaux de risque bâtiment (argile/radon/sismique — table BDNB
     `batiment_groupe_risques`, story D2) du bâtiment diagnostiqué : alimente
     la section Risques de la fiche BDNB et le mode carte « Risques bâtiment ». */
  const [batimentRisques, setBatimentRisques] = useState<BatimentRisques | null>(null);
  /* Trajectoire climatique (variables brutes F par péril et par horizon) —
     capturée depuis la réponse /diagnostic/fast (digital_twin.trajectoire),
     la même requête qui alimente déjà les recommandations. Vue « Assurance ». */
  const [trajectoire, setTrajectoire] = useState<Trajectoire | null>(null);
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

  async function loadDetailedRecommendations(address: string) {
    const requestId = ++recommendationsRequestId.current;
    setDetailedRecommendationsLoading(true);
    setDetailedRecommendationsError(null);
    setDetailedRecommendationZones({});
    try {
      const fastResponse = await fetch(`${API}/diagnostic/fast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        /* Copernicus activé (fail-soft si la licence CDS n'est pas encore
           acceptée) + scénario RCP par défaut : les points 2100 projetés
           portent alors la comparaison rcp4_5 / rcp8_5 pour la carte de
           décision (sélecteur instantané, sans relancer le diagnostic). */
        body: JSON.stringify({ adresse: address, copernicus: true, scenario: 'rcp8_5' }),
      });
      if (!fastResponse.ok) throw new Error(`Diagnostic détaillé HTTP ${fastResponse.status}`);
      const fastContract = await fastResponse.json();
      if (!fastContract?._resume) throw new Error('Contexte de recommandations absent');
      /* Trajectoire climatique (vue Assurance) : le digital_twin porte la
         trajectoire produite par risk_model.compute_trajectoire. On la met
         aussi en cache pour qu'un re-diagnostic (servi depuis le cache) la
         restitue sans appel réseau. */
      if (fastContract.trajectoire && typeof fastContract.trajectoire === 'object') {
        const traj = fastContract.trajectoire as Trajectoire;
        setTrajectoire(traj);
        putCachedTrajectoire(address, traj);
      }

      const recommendationsResponse = await fetch(`${API}/diagnostic/recommandations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fastContract._resume),
      });
      if (!recommendationsResponse.ok) throw new Error(`Recommandations HTTP ${recommendationsResponse.status}`);
      const detailedContract = await recommendationsResponse.json();
      if (requestId !== recommendationsRequestId.current) return;
      setDetailedRecommendationZones(detailedContract?.zones || {});
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
       fraîche), on restitue le rapport complet + le rapport Mistral sans
       aucun appel réseau. */
    if (!opts.force) {
      const cached = getCachedDiagnostic(value);
      if (cached) {
        setReport(cached.report);
        setRapport(cached.rapport ?? null);
        setTrajectoire(cached.trajectoire ?? null);
        setRapportError(null);
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
        /* Diagnostic en cache ANTÉRIEUR à la mise en service Copernicus : le
           rapport restauré n'a pas de trajectoire. On la rattrape en
           arrière-plan (POST /diagnostic/fast uniquement — pas de
           re-diagnostic complet) : la restitution reste instantanée, la
           carte de décision se remplit dès que le contrat arrive, et le
           cache est mis à jour (putCachedTrajectoire) pour ne le faire
           qu'une seule fois par adresse. */
        if (!cached.trajectoire) {
          void backfillTrajectoire(cached.report.adresse_normalisee || value);
        }
        return;
      }
    }

    setLoading(true);
    if (!opts.force) {
      /* Nouveau diagnostic : on nettoie l'ancien état pendant le chargement. */
      setReport(null);
      setRapport(null);
      setRapportError(null);
      setFromCache(false);
      setTrajectoire(null);
    }
    /* Rafraîchissement forcé : on laisse le rapport actuel (et son badge
       éventuel) en place pendant le chargement — il n'est remplacé qu'en
       cas de succès, jamais effacé si le réseau échoue. */
    recommendationsRequestId.current += 1;
    setDetailedRecommendationZones({});
    setDetailedRecommendationsLoading(false);
    setDetailedRecommendationsError(null);

    try {
      const resp = await fetch(`${API}/diagnostic/adresse?q=${encodeURIComponent(value)}`);

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

      const r = (await resp.json()) as RisqueReport;
      setReport(r);
      /* Watchlist : enregistre le dernier comptage CatNat observé pour cette
         adresse (données déjà fetchées — alimente le badge sans appel réseau). */
      const catnatCount = (r.aleas || []).reduce(
        (acc, a) => acc + (a.catnat_historique?.length ?? 0),
        0
      );
      setCatNatLatest((prev) => {
        const next = recordCatNatLatest(prev, r.adresse_normalisee || value, catnatCount);
        saveCatNatLatest(next);
        return next;
      });
      void loadDetailedRecommendations(r.adresse_normalisee || value);
      setFromCache(false); // données fraîches du réseau → badge « en cache » retiré
      putCachedDiagnostic(r); // sauvegarde le résultat pour les prochains passages
      /* Historique « Récent » (localStorage) : adresse normalisée ou requête brute. */
      setConversations((prev) => {
        const next = addConversation(prev, r.adresse_normalisee || value);
        saveConversations(next);
        return next;
      });
      setStepError(false); // l'adresse est validée → étapes suivantes débloquées
      setStep(1); // → étape Cartographie (aléas + carte unifiée)
      setVisibleLayerKeys(
        new Set((r.aleas || []).filter((a) => a.present !== null).map((a) => a.code))
      );
    } catch {
      setDiagError('Erreur réseau — backend inaccessible ?');
    } finally {
      setLoading(false);
    }
  }

  /* Rattrapage trajectoire pour les diagnostics en cache antérieurs à
     Copernicus : relance uniquement /diagnostic/fast (léger, sans
     recommandations) pour remplir la carte de décision sans re-diagnostiquer
     l'adresse. Fail-soft : si le contrat ou la trajectoire manquent, on
     laisse la restitution en cache telle quelle. */
  async function backfillTrajectoire(address: string) {
    try {
      const resp = await fetch(`${API}/diagnostic/fast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adresse: address, copernicus: true, scenario: 'rcp8_5' }),
      });
      if (!resp.ok) return;
      const contract = await resp.json();
      if (contract?.trajectoire && typeof contract.trajectoire === 'object') {
        const traj = contract.trajectoire as Trajectoire;
        setTrajectoire(traj);
        putCachedTrajectoire(address, traj);
      }
    } catch {
      /* Non bloquant : la restitution en cache reste valable. */
    }
  }

  /* Rafraîchissement forcé : ignore le cache et relance le diagnostic réseau,
     puis met à jour l'entrée cachée (le rapport Mistral est conservé). */
  function handleRefresh() {
    if (!report) return;
    void runDiagnosis(report.adresse_normalisee || report.adresse_saisie, { force: true });
  }

  /* ── Rapport narratif IA (Mistral) — POST RisqueReport → RapportNarratif ── */
  async function loadRapport() {
    if (!report || rapport || rapportLoading) return;
    /* Rapport Mistral déjà généré pour cette adresse (cache) → restitution
       immédiate, aucun appel IA. */
    if (!fromCache) {
      const cached = getCachedDiagnostic(report.adresse_normalisee || report.adresse_saisie);
      if (cached?.rapport) {
        setRapport(cached.rapport);
        return;
      }
    }
    setRapportLoading(true);
    setRapportError(null);
    try {
      const resp = await fetch(`${API}/diagnostic/adresse/rapport`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(report),
      });
      if (!resp.ok) {
        // Contrat backend : detail = { error, detail, cause }. On gère aussi
        // le cas FastAPI où detail est une simple chaîne ({"detail": "..."}).
        const err = await resp.json().catch(() => null);
        const rawDetail = err?.detail;
        const d =
          rawDetail && typeof rawDetail === 'object'
            ? rawDetail
            : rawDetail && typeof rawDetail === 'string'
              ? { detail: rawDetail }
              : err ?? {};
        setRapportError({
          code: d.error || `http_${resp.status}`,
          status: resp.status,
          message:
            d.detail ||
            (resp.status === 503
              ? 'Le rapport IA nécessite une clé Mistral côté serveur.'
              : `Le service n'a pas pu générer le rapport (HTTP ${resp.status}).`),
          hint: hintForRapportError(d.error, resp.status),
          cause: d.cause || undefined,
        });
        return;
      }
      const r = (await resp.json()) as RapportNarratif;
      setRapport(r);
      putCachedRapport(report, r); // on garde le rapport IA généré (coûteux)
    } catch (err) {
      // fetch() a échoué : backend injoignable, CORS, DNS…
      setRapportError({
        code: 'reseau',
        message: 'Impossible de joindre le serveur pour générer le rapport IA.',
        hint: 'Vérifiez que le backend Typhon est démarré (port 8000) puis réessayez.',
        cause: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRapportLoading(false);
    }
  }

  /* Conseil actionnable selon le code d'erreur renvoyé par le backend. */
  function hintForRapportError(code: string | undefined, status: number): string | undefined {
    if (code === 'mistral_api_key_manquante') {
      return "Ajoutez MISTRAL_API_KEY au fichier .env du backend puis redémarrez l'API.";
    }
    if (code === 'mistral_indisponible' || status === 502) {
      return 'Le service Mistral est momentanément indisponible ou a expiré — réessayez dans quelques instants.';
    }
    if (status === 503) {
      return 'Le service de génération IA n\'est pas configuré côté serveur.';
    }
    if (status >= 500) {
      return 'Le serveur a rencontré une erreur interne — réessayez, ou relancez le backend si cela persiste.';
    }
    return undefined;
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
    if (i === 5 && report) void loadRapport();
  }

  /* ── Export PDF du rapport IA (client-side, jsPDF importé à la demande) ── */
  async function handleExportPdf() {
    if (!report || !rapport || exportingPdf) return;
    setExportingPdf(true);
    setExportPdfError(null);
    try {
      const { exportRapportPdf } = await import('../zone/pdf-export');
      await exportRapportPdf(report, rapport);
    } catch (err) {
      console.error('Export PDF du rapport IA échoué :', err);
      setExportPdfError(
        "L'export PDF a échoué dans le navigateur. Réessayez — si le problème persiste, utilisez le lien « PDF officiel Géorisques »."
      );
    } finally {
      setExportingPdf(false);
    }
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
     (l'assurance est volontairement Adresse → Bien & contexte →
     Synthèse → Projection climatique → Rapport IA). */
  const profileSteps = (STEP_ORDER[profile] || STEP_ORDER.promoteur).map((id, i) => ({
    id,
    label: STEP_LABELS[id] ?? id,
    index: i,
  }));
  const currentStepId = profileSteps[step]?.id ?? 'adresse';
  /* Étapes qui embarquent la carte unifiée (panneau latéral + carte). */
  const isMapStep = ['carto', 'analyse', 'decision', 'copernicus'].includes(currentStepId);

  /* ── Dérivés du rapport ── */
  const presentAleas = (report?.aleas || []).filter((a) => a.present === true);
  /* Aléas dont la source est disponible (présents OU absents) : les absents
     restent visualisables sur la carte via les couches communales WMS/WFS. */
  const togglableAleas = (report?.aleas || []).filter((a) => a.present !== null);
  const maxScore = presentAleas.length ? Math.max(...presentAleas.map((a) => aleaScore(a))) : null;
  const band = maxScore != null ? D03.find((b) => (maxScore as number) < b.max) || D03[D03.length - 1] : null;

  const catnat = (report?.aleas || []).flatMap((a) =>
    (a.catnat_historique || []).map((ev) => ({
      ...ev,
      alea_libelle: a.libelle,
    }))
  );

  /* « Tout masquer » n'est affiché que si TOUS les aléas à source disponible
     sont visibles — c'est ce que la carte peut réellement montrer (les aléas
     absents ont leurs couches communales WMS/WFS). */
  const allTogglableVisible =
    report !== null &&
    togglableAleas.length > 0 &&
    togglableAleas.every((a) => visibleLayerKeys.has(a.code));

  /* ── Cartographie & Synthèse : couches visibles dès l'arrivée ──
     Sur les onglets qui affichent les aléas Géorisques (Cartographie et
     Synthèse), toutes les couches disponibles passent visibles
     automatiquement, une seule fois par rapport — y compris celles où
     l'adresse n'est PAS concernée (les couches communales WMS/WFS se voient
     ainsi sans avoir à cliquer chaque œil). Les toggles manuels du panneau
     restent ensuite le contrôle : quitter puis revenir à l'onglet ne
     réinitialise pas le choix de l'utilisateur. */
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

  /* ── Projection climatique : rattrapage auto-réparant ──
     Si on arrive sur l'onglet sans trajectoire (diagnostic servi du cache
     avant Copernicus, ou backfill initial échoué — backend momentanément
     injoignable), on retente le rattrapage /diagnostic/fast. L'onglet se
     remplit dès que le backend répond, sans re-diagnostiquer l'adresse. */
  useEffect(() => {
    if (currentStepId !== 'copernicus' || !report || trajectoire) return;
    void backfillTrajectoire(report.adresse_normalisee || report.adresse_saisie);
  }, [currentStepId, report, trajectoire]);

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
                    ) : currentStepId === 'copernicus' ? (
                      <CopernicusPanel trajectoire={trajectoire} />
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

            {/* ÉTAPE 6 — RAPPORT IA (narratif Mistral + export PDF) */}
            <section className="zone-report" hidden={currentStepId !== 'rapport'}>
              {!report ? (
                <div className="report-empty">
                  <md-icon>description</md-icon>
                  <h2>Aucun diagnostic</h2>
                  <p>Diagnostiquez d'abord une adresse pour générer le rapport d'analyse IA.</p>
                  <md-filled-button onClick={() => goToStep(0)}>
                    <md-icon slot="icon">search</md-icon> Chercher une adresse
                  </md-filled-button>
                </div>
              ) : rapportLoading ? (
                <div className="report-empty">
                  <md-icon>psychology</md-icon>
                  <h2>Génération du rapport IA…</h2>
                  <p>Mistral analyse les données Géorisques de {report.adresse_normalisee}.</p>
                  <md-linear-progress indeterminate></md-linear-progress>
                </div>
              ) : rapportError ? (
                <div className="report-error" role="alert">
                  <div className="report-error-icon">
                    <md-icon>
                      {rapportError.code === 'mistral_api_key_manquante'
                        ? 'vpn_key'
                        : rapportError.code === 'reseau'
                          ? 'wifi_off'
                          : 'cloud_off'}
                    </md-icon>
                  </div>
                  <h2>Rapport indisponible</h2>
                  <p className="report-error-msg">{rapportError.message}</p>
                  {rapportError.hint ? (
                    <p className="report-error-hint">
                      <md-icon>lightbulb</md-icon>
                      <span>{rapportError.hint}</span>
                    </p>
                  ) : null}
                  {rapportError.cause ? (
                    <details className="report-error-details">
                      <summary>
                        <md-icon>bug_report</md-icon> Détail technique
                      </summary>
                      <code>
                        [{rapportError.code}
                        {rapportError.status ? ` · HTTP ${rapportError.status}` : ''}] {rapportError.cause}
                      </code>
                    </details>
                  ) : null}
                  <div className="report-error-actions">
                    <md-filled-button onClick={() => void loadRapport()}>
                      <md-icon slot="icon">refresh</md-icon> Réessayer
                    </md-filled-button>
                    <md-text-button onClick={() => goToStep(0)}>
                      <md-icon slot="icon">search</md-icon> Nouvelle adresse
                    </md-text-button>
                  </div>
                </div>
              ) : rapport ? (
                <>
                  <header className="report-header">
                    <div className="report-title">
                      <h2>Rapport d'analyse IA</h2>
                      <p className="report-meta">
                        {report.adresse_normalisee} · Code INSEE {report.code_insee} ·{' '}
                        {report.date_generation}
                      </p>
                    </div>
                    <div className="report-export-group">
                      <md-filled-button
                        className="pdf-btn report-export"
                        disabled={exportingPdf}
                        onClick={() => void handleExportPdf()}
                      >
                        <md-icon slot="icon">picture_as_pdf</md-icon>
                        {exportingPdf ? 'Export en cours…' : 'Exporter en PDF'}
                      </md-filled-button>
                      <a
                        className="report-export-secondary"
                        href={pdfUrl}
                        target="_blank"
                        rel="noopener"
                      >
                        PDF officiel Géorisques (ERRIAL)
                      </a>
                      {exportPdfError && <p className="report-export-error">{exportPdfError}</p>}
                    </div>
                  </header>

                  <p className="report-intro">{rapport.introduction}</p>

                  <div className="report-sections">
                    {rapport.sections.map((s, i) => (
                      <article className="report-section" key={i}>
                        <h3>{s.titre}</h3>
                        <p>{s.contenu}</p>
                      </article>
                    ))}
                  </div>

                  <aside className="report-synthese">
                    <md-icon>summarize</md-icon>
                    <div>
                      <h3>Synthèse finale</h3>
                      <p>{rapport.synthese_finale}</p>
                    </div>
                  </aside>

                  {rapport.obligations_reglementaires &&
                    rapport.obligations_reglementaires.length > 0 && (
                      <section className="report-obligations">
                        <h3>Obligations réglementaires</h3>
                        <ul>
                          {rapport.obligations_reglementaires.map((o, i) => (
                            <li key={i}>{o}</li>
                          ))}
                        </ul>
                      </section>
                    )}

                  <p className="report-avertissement">
                    <md-icon>info</md-icon>
                    <span>
                      {rapport.avertissement_ia ||
                        "Ce rapport est généré automatiquement par IA à partir des données publiques Géorisques normalisées. Il ne remplace pas l'ERRIAL ni l'avis d'un expert."}
                    </span>
                  </p>
                </>
              ) : (
                <div className="report-empty">
                  <md-icon>description</md-icon>
                  <h2>Prêt à générer</h2>
                  <p>
                    Générez le rapport narratif IA à partir du diagnostic{' '}
                    {report.adresse_normalisee}.
                  </p>
                  <md-filled-button onClick={() => void loadRapport()}>
                    <md-icon slot="icon">auto_awesome</md-icon> Générer le rapport
                  </md-filled-button>
                </div>
              )}
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
function AleaCard({
  alea,
  visible,
  onToggle,
}: {
  alea: AleaDetail;
  visible: boolean;
  onToggle: () => void;
}) {
  const band = alea.niveau ? bandForKey(alea.niveau) : undefined;
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
  /* L'œil est actif dès que la source est disponible (présent OU absent) :
     un aléa non présent reste visualisable via la couche communale WMS/WFS.
     Seule une source indisponible (present=null) n'a rien à montrer. */
  const canToggle = alea.present !== null;

  return (
    <div className={`alea-card${isAbsent ? ' absent' : ''}${isError ? ' error-partial' : ''}`}>
      <div className="alea-head">
        <span className={`alea-icon ${band ? band.cls : ''}`}>
          <md-icon>{icon}</md-icon>
        </span>
        <span className="alea-name">{alea.libelle}</span>
        {band && (alea.present === true || alea.present_commune === true) ? (
          <span className={`d03-pill ${band.cls}`}>{band.label}</span>
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
