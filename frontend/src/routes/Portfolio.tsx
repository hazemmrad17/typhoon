// =============================================================================
//   TYPHOON — /portfolio : vue « livre » de l'assureur (Ticket 4 — insurerpagesplan)
//   Import CSV (une colonne : adresse) → POST /diagnostic/batch (route interne,
//   sans clé d'API) → polling → tableau (adresse · score · bande D03 ·
//   résolution · flag « à expertiser »), histogramme des bandes, heatmap
//   (UnifiedMap en mode points) et exports CSV + PDF de synthèse.
//
//   Les résultats de lot vivent en sessionStorage (pas diagnosticCache, qui
//   est plafonné à 30 entrées pour un historique mono-adresse).
// =============================================================================

import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { CSSProperties } from 'react';
import { ZoneSidenav, useIsMobile } from '../components/ZoneSidenav';
import { UnifiedMap, type PortfolioPoint } from '../components/UnifiedMap';
import { useTyphoonTheme } from '../typhoon/useTyphoonTheme';
import { useUserProfile } from '../typhoon/useUserProfile';
import { API, D03, bandForKey } from '../zone/config';
import {
  loadConversations,
  removeConversation,
  saveConversations,
  type Conversation,
} from '../zone/conversations';
import { removeCachedDiagnostic } from '../zone/diagnosticCache';
import '../styles/zone.css';

/* ── Types du contrat batch interne (même forme que la Partner API) ── */

interface BatchItem {
  address: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  result: {
    adresse: { label?: string; citycode?: string };
    score_global?: number;
    niveau_global?: string;
    trajectoire?: {
      perils?: Record<string, { points: { horizon: number; resolution?: string | null }[] }>;
    } | null;
  } | null;
  error?: string | null;
}

interface BatchPoll {
  batch_id: string;
  status: string;
  total: number;
  completed: number;
  failed: number;
  items: BatchItem[];
}

const SESSION_KEY = 'typhoon.portfolio.batch';

/* Découpe un CSV d'adresses (une colonne). Tolérant au BOM, aux guillemets
   et aux virgules entre guillemets — on ne retient que les lignes non vides,
   en prenant la première colonne de chaque ligne (l'adresse). */
function parseAddressCsv(text: string): string[] {
  const rows: string[] = [];
  let current = '';
  let inQuotes = false;
  const flush = () => {
    const t = current.trim().replace(/\uFEFF/g, '');
    if (t && t.toLowerCase() !== 'adresse') rows.push(t);
    current = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if ((ch === '\n' || ch === '\r') && !inQuotes) {
      flush();
      continue;
    }
    if (ch === ',' && !inQuotes) {
      /* Colonnes multiples : la première colonne est l'adresse. */
      const t = current.trim().replace(/\uFEFF/g, '');
      if (t && t.toLowerCase() !== 'adresse') {
        rows.push(t);
      }
      current = '';
      continue;
    }
    current += ch;
  }
  flush();
  return rows;
}

function csvToDataUrl(csv: string): string {
  return 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
}

export function Portfolio() {
  const navigate = useNavigate();
  const location = useLocation();
  const { theme, accent, mode, setThemeMode } = useTyphoonTheme();
  const { profile } = useUserProfile();
  const isMobile = useIsMobile();

  const [navCollapsed, setNavCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const sidenavRef = useRef<HTMLElement | null>(null);

  const [conversations, setConversations] = useState<Conversation[]>(() => loadConversations());
  const handleDeleteConversation = (id: string) => {
    setConversations((prev) => {
      const victim = prev.find((c) => c.id === id);
      const next = removeConversation(prev, id);
      saveConversations(next);
      if (victim) removeCachedDiagnostic(victim.address);
      return next;
    });
  };

  /* ── État du lot ── */
  const [csvText, setCsvText] = useState('');
  const [csvFileName, setCsvFileName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [batch, setBatch] = useState<BatchPoll | null>(null);
  const pollTimer = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /* Restauration session (rechargement de page). */
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as { batch: BatchPoll; csvText: string; csvFileName: string };
        if (saved?.batch) {
          setBatch(saved.batch);
          setCsvText(saved.csvText || '');
          setCsvFileName(saved.csvFileName || '');
        }
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    return () => {
      if (pollTimer.current) window.clearInterval(pollTimer.current);
    };
  }, []);

  /* Polling pendant le traitement. */
  useEffect(() => {
    if (!batch || batch.status === 'completed' || batch.status === 'failed') return;
    if (pollTimer.current) window.clearInterval(pollTimer.current);
    pollTimer.current = window.setInterval(async () => {
      try {
        const resp = await fetch(`${API}/diagnostic/batch/${batch.batch_id}`);
        if (!resp.ok) return;
        const next = (await resp.json()) as BatchPoll;
        setBatch(next);
        sessionStorage.setItem(
          SESSION_KEY,
          JSON.stringify({ batch: next, csvText, csvFileName })
        );
        if (next.status === 'completed' || next.status === 'failed') {
          if (pollTimer.current) window.clearInterval(pollTimer.current);
        }
      } catch { /* backend down — retry next tick */ }
    }, 2500);
    return () => {
      if (pollTimer.current) window.clearInterval(pollTimer.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch?.batch_id, batch?.status]);

  async function handleFile(file: File) {
    setCsvFileName(file.name);
    setError(null);
    const text = await file.text();
    setCsvText(text);
    const addresses = parseAddressCsv(text);
    if (addresses.length === 0) {
      setError('Aucune adresse trouvée dans le fichier CSV.');
      return;
    }
    if (addresses.length > 1000) {
      setError(`Fichier trop grand : ${addresses.length} adresses. Maximum 1 000 pour cette démo.`);
      return;
    }
    await submit(addresses);
  }

  async function submit(addresses: string[]) {
    setSubmitting(true);
    setError(null);
    setBatch(null);
    try {
      const resp = await fetch(`${API}/diagnostic/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addresses, scenario: 'rcp8_5' }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => null);
        throw new Error(err?.detail || `HTTP ${resp.status}`);
      }
      const submitResp = (await resp.json()) as { batch_id: string; status: string; total: number };
      /* Lot initial : items pending. */
      const initial: BatchPoll = {
        batch_id: submitResp.batch_id,
        status: submitResp.status,
        total: submitResp.total,
        completed: 0,
        failed: 0,
        items: addresses.map((a) => ({ address: a, status: 'pending' as const, result: null, error: null })),
      };
      setBatch(initial);
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ batch: initial, csvText, csvFileName }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur de soumission du lot.');
    } finally {
      setSubmitting(false);
    }
  }

  /* ── Dérivés du tableau ── */
  const completedItems = batch?.items.filter((it) => it.status === 'completed') ?? [];
  const histogram = D03.map((b) => ({
    band: b,
    count: completedItems.filter((it) => it.result?.niveau_global === b.key).length,
  }));
  const histogramMax = Math.max(1, ...histogram.map((h) => h.count));
  const needsReview = completedItems.filter((it) => {
    const k = it.result?.niveau_global;
    return k === 'eleve' || k === 'critique';
  }).length;

  const points: PortfolioPoint[] = completedItems
    .map((it) => {
      const r = it.result;
      const adr = r?.adresse;
      if (!adr || adr.label == null) return null;
      /* Résolution : première valeur non nulle des points de trajectoire. */
      const perils = r?.trajectoire?.perils;
      let resolution: string | null = null;
      if (perils) {
        for (const p of Object.values(perils)) {
          for (const pt of p.points) {
            if (pt.resolution) { resolution = pt.resolution; break; }
          }
          if (resolution) break;
        }
      }
      const lat = (adr as { lat?: number }).lat;
      const lon = (adr as { lon?: number }).lon;
      if (typeof lat !== 'number' || typeof lon !== 'number' || !isFinite(lat) || !isFinite(lon)) return null;
      return {
        lat,
        lon,
        label: adr.label,
        band: r?.niveau_global ?? null,
        score: r?.score_global ?? null,
      } as PortfolioPoint;
    })
    .filter((p): p is PortfolioPoint => p !== null);

  function exportCsv() {
    if (!batch) return;
    const header = 'adresse;score;bande;resolution;a_expertiser;statut';
    const rows = batch.items.map((it) => {
      const r = it.result;
      const band = r?.niveau_global ?? '';
      const resolution = (() => {
        const perils = r?.trajectoire?.perils;
        for (const p of Object.values(perils ?? {})) {
          for (const pt of p.points) if (pt.resolution) return pt.resolution;
        }
        return '';
      })();
      return [
        `"${(r?.adresse?.label ?? it.address).replace(/"/g, '""')}"`,
        r?.score_global ?? '',
        band,
        resolution,
        band === 'eleve' || band === 'critique' ? 'OUI' : '',
        it.status,
      ].join(';');
    });
    const a = document.createElement('a');
    a.href = csvToDataUrl([header, ...rows].join('\n'));
    a.download = `portfolio_typhoon_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  }

  async function exportPdf() {
    if (!batch) return;
    const { exportPortfolioPdf } = await import('../zone/pdf-export');
    await exportPortfolioPdf({
      items: batch.items,
      histogram: histogram.map((h) => ({ key: h.band.key, label: h.band.label, color: h.band.color, count: h.count })),
      total: batch.total,
      completed: batch.completed,
      failed: batch.failed,
    });
  }

  /* ── CSV : l'adresse est une simple colonne — les points n'ont pas de
     coordonnées GPS dans le CSV, on n'affiche donc la heatmap que si les
     résultats portent des coordonnées (trajectoire non garantie). Pour cette
     version, la heatmap affiche les adresses résolues par bande. */
  const showHeatmap = points.length > 0;

  return (
    <main
      className={`zone-app portfolio-page${theme === 'light' ? ' theme-light' : ''}${
        navCollapsed && !isMobile ? ' nav-collapsed' : ''
      }${drawerOpen ? ' drawer-open' : ''}`}
      style={{ '--accent': accent } as CSSProperties}
    >
      <ZoneSidenav
        sidenavRef={sidenavRef}
        collapsed={navCollapsed && !isMobile}
        mobile={isMobile}
        hidden={isMobile && !drawerOpen}
        theme={theme}
        mode={mode}
        profile={profile}
        activePath={location.pathname}
        onThemeModeChange={setThemeMode}
        onToggleCollapse={() => (isMobile ? setDrawerOpen(false) : setNavCollapsed((c) => !c))}
        onOpenAccount={() => { setDrawerOpen(false); navigate('/settings/account'); }}
        onNavigateSettings={(tab) => { setDrawerOpen(false); navigate(`/settings/${tab}`); }}
        onSignOut={() => { setDrawerOpen(false); navigate('/'); }}
        onCloseDrawer={() => setDrawerOpen(false)}
        onNewDiagnostic={() => { setDrawerOpen(false); navigate('/zone'); }}
        onNavigate={(path) => { setDrawerOpen(false); navigate(path); }}
        conversations={conversations}
        activeAddress={null}
        onOpenConversation={(address) => { setDrawerOpen(false); navigate(`/zone?q=${encodeURIComponent(address)}`); }}
        onDeleteConversation={handleDeleteConversation}
      />

      <div className="zone-main">
        <div className="portfolio-scroll">
          <header className="portfolio-header">
            <md-icon-button
              className="sidenav-hamburger account-settings-hamburger"
              aria-label="Ouvrir le menu"
              onClick={() => setDrawerOpen(true)}
            >
              <md-icon>menu</md-icon>
            </md-icon-button>
            <div className="account-settings-title">
              <h1>Portfolio</h1>
              <p>
                Analysez un livre d'adresses en lot : import CSV, bandes D03,
                cartographie et exports.
              </p>
            </div>
            <md-filled-button onClick={() => navigate('/zone')}>
              <md-icon slot="icon">science</md-icon>
              Nouveau diagnostic
            </md-filled-button>
          </header>

          {/* ── Import CSV ── */}
          <section className="portfolio-import">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
              }}
            />
            <div className="portfolio-import-copy">
              <h2>1. Importer un livre d'adresses</h2>
              <p>Fichier CSV avec une colonne <strong>adresse</strong> (une adresse par ligne).</p>
            </div>
            <md-filled-button
              className="portfolio-upload-btn"
              disabled={submitting}
              onClick={() => fileInputRef.current?.click()}
            >
              <md-icon slot="icon">{submitting ? 'hourglass_top' : 'upload_file'}</md-icon>
              {submitting ? 'Soumission…' : csvFileName ? `Re-import : ${csvFileName}` : 'Choisir un CSV'}
            </md-filled-button>
          </section>

          {error && (
            <div className="portfolio-error" role="alert">
              <md-icon>error</md-icon>
              <span>{error}</span>
            </div>
          )}

          {/* ── Résultats ── */}
          {batch && (
            <>
              <section className="portfolio-summary">
                <div className="portfolio-summary-stat">
                  <span className="portfolio-summary-num">{batch.total}</span>
                  <span className="portfolio-summary-label">adresses</span>
                </div>
                <div className="portfolio-summary-stat">
                  <span className="portfolio-summary-num">{batch.completed}</span>
                  <span className="portfolio-summary-label">terminées</span>
                </div>
                <div className="portfolio-summary-stat">
                  <span className="portfolio-summary-num portfolio-summary-failed">{batch.failed}</span>
                  <span className="portfolio-summary-label">en erreur</span>
                </div>
                <div className="portfolio-summary-stat">
                  <span className="portfolio-summary-num portfolio-summary-review">{needsReview}</span>
                  <span className="portfolio-summary-label">à expertiser</span>
                </div>
                <span className={`portfolio-status ${batch.status}`}>
                  {batch.status === 'completed' ? (
                    <><md-icon>check_circle</md-icon> Terminé</>
                  ) : batch.status === 'failed' ? (
                    <><md-icon>error</md-icon> Échec partiel</>
                  ) : (
                    <><md-icon>sync</md-icon> Traitement en cours…</>
                  )}
                </span>
              </section>

              {/* ── Histogramme D03 ── */}
              <section className="portfolio-histogram" aria-label="Histogramme des bandes D03">
                <h2>2. Répartition par bande D03</h2>
                <div className="portfolio-hist-bars">
                  {histogram.map(({ band, count }) => (
                    <div className="portfolio-hist-col" key={band.key}>
                      <span className="portfolio-hist-count">{count}</span>
                      <div
                        className="portfolio-hist-bar"
                        style={{ height: `${Math.max(4, (count / histogramMax) * 120)}px`, background: band.color }}
                        title={`${band.label} : ${count}`}
                      />
                      <span className="portfolio-hist-label">{band.label}</span>
                    </div>
                  ))}
                </div>
                {histogramMax <= 1 && batch.completed === 0 && (
                  <p className="portfolio-hist-empty">Aucun résultat terminé pour l'instant.</p>
                )}
              </section>

              {/* ── Heatmap ── */}
              {showHeatmap && (
                <section className="portfolio-map">
                  <h2>3. Cartographie des risques</h2>
                  <div className="portfolio-map-wrap">
                    <UnifiedMap report={null} points={points} initial3D={false} />
                  </div>
                </section>
              )}

              {/* ── Tableau ── */}
              <section className="portfolio-table-section">
                <div className="portfolio-table-head">
                  <h2>4. Détail par adresse</h2>
                  <div className="portfolio-export-actions">
                    <md-text-button onClick={exportCsv}>
                      <md-icon slot="icon">file_download</md-icon>
                      Exporter CSV
                    </md-text-button>
                    <md-filled-button onClick={() => void exportPdf()}>
                      <md-icon slot="icon">picture_as_pdf</md-icon>
                      Synthèse PDF
                    </md-filled-button>
                  </div>
                </div>
                <div className="portfolio-table-scroll">
                  <table className="portfolio-table">
                    <thead>
                      <tr>
                        <th>Adresse</th>
                        <th>Score</th>
                        <th>Bande D03</th>
                        <th>Résolution</th>
                        <th>À expertiser</th>
                        <th>Statut</th>
                      </tr>
                    </thead>
                    <tbody>
                      {batch.items.map((it, i) => {
                        const r = it.result;
                        const band = r?.niveau_global ? bandForKey(r.niveau_global) : undefined;
                        let resolution = '—';
                        const perils = r?.trajectoire?.perils;
                        if (perils) {
                          for (const p of Object.values(perils)) {
                            for (const pt of p.points) {
                              if (pt.resolution) { resolution = pt.resolution; break; }
                            }
                            if (resolution !== '—') break;
                          }
                        }
                        const review = band?.key === 'eleve' || band?.key === 'critique';
                        return (
                          <tr key={i}>
                            <td className="portfolio-cell-addr" title={r?.adresse?.label ?? it.address}>
                              {r?.adresse?.label ?? it.address}
                            </td>
                            <td>{r?.score_global ?? '—'}</td>
                            <td>
                              {band ? (
                                <span className={`d03-pill ${band.cls}`}>{band.label}</span>
                              ) : (
                                '—'
                              )}
                            </td>
                            <td>{resolution === 'per-building' ? 'Par bâtiment' : resolution === 'commune-level' ? 'Communale' : resolution === 'grid-cell' ? 'Grille' : resolution}</td>
                            <td>{review ? <span className="portfolio-review-flag">OUI</span> : ''}</td>
                            <td>
                              <span className={`portfolio-item-status ${it.status}`}>
                                {it.status === 'completed' ? 'OK' : it.status === 'failed' ? 'Erreur' : it.status}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {batch.items.some((it) => it.status === 'failed') && (
                  <p className="portfolio-partial-note">
                    Certaines adresses n'ont pas pu être analysées (adresse non reconnue) — elles
                    n'affectent pas le reste du lot.
                  </p>
                )}
              </section>
            </>
          )}

          {!batch && !submitting && (
            <section className="portfolio-empty">
              <md-icon>dashboard</md-icon>
              <h2>Aucun lot chargé</h2>
              <p>
                Importez un fichier CSV d'adresses pour lancer l'analyse du livre.
              </p>
            </section>
          )}
        </div>
      </div>

      <div
        className={`zone-scrim${drawerOpen ? ' visible' : ''}`}
        aria-hidden="true"
        onClick={() => setDrawerOpen(false)}
      />
    </main>
  );
}
