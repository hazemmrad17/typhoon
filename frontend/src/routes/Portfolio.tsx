// =============================================================================
//   TYPHOON — /portfolio : analyse d'un livre d'adresses en lot (FR-20)
//
//   Import CSV (une colonne : adresse) → POST /diagnostic/batch → polling →
//   tableau (adresse · aléas vérifiés · résolution la plus fine · flag « à
//   expertiser »), histogramme des résolutions, heatmap, exports CSV/PDF.
//
//   Aucun score : les colonnes portent la QUALITÉ de résolution de chaque
//   fait (per-building / commune-level / estimation communale), pas un
//   jugement (constitution §2). Le lot est N × le pipeline canonique.
// =============================================================================

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { UnifiedMap } from '../components/UnifiedMap';
import { ZoneSidenav, useIsMobile } from '../components/ZoneSidenav';
import { useTyphoonTheme } from '../typhoon/useTyphoonTheme';
import { useUserProfile } from '../typhoon/useUserProfile';
import { useAuth } from '../typhoon/auth';
import { API, RESOLUTION_BADGES, RESOLUTION_BANDS } from '../zone/config';

/* ── Contrat batch canonique (FR-20) ── */
interface CanonicalResult {
  schema_version: string;
  adresse: {
    saisie: string;
    normalisee: string;
    citycode: string;
    postcode?: string | null;
    city?: string | null;
    lat: number;
    lon: number;
    geocode_score?: number | null;
  };
  aleas: Array<{
    code: string;
    libelle: string;
    present: boolean | null;
    resolution: 'per-building' | 'commune-level' | 'commune-level-estimate';
    erreur?: string | null;
  }>;
  erreurs_partielles?: string[];
}

interface BatchPoll {
  batch_id: string;
  status: 'pending' | 'done';
  results: CanonicalResult[];
  item_errors: Array<{ adresse: string; erreur: string }>;
}

const SESSION_KEY = 'typhoon.portfolio.batch';

interface PortfolioPoint {
  lat: number;
  lon: number;
  label: string;
  resolution: string | null;
}

/** Résolution la plus fine présente dans un record (pour histogramme/badge). */
function finestResolution(r: CanonicalResult): string | null {
  if (r.aleas.some((a) => a.resolution === 'per-building')) return 'per-building';
  if (r.aleas.some((a) => a.resolution === 'commune-level')) return 'commune-level';
  if (r.aleas.some((a) => a.resolution === 'commune-level-estimate')) return 'commune-level-estimate';
  return null;
}

/** Estimation communale sans aucun aléa vérifié au bâtiment → à expertiser. */
function needsExpertReview(r: CanonicalResult): boolean {
  const finest = finestResolution(r);
  return r.aleas.length > 0 && finest === 'commune-level-estimate';
}

export function Portfolio() {
  const navigate = useNavigate();
  const location = useLocation();
  const { theme, accent, mode, setThemeMode } = useTyphoonTheme();
  const { profile } = useUserProfile();
  const { signOut } = useAuth();
  const isMobile = useIsMobile();
  const [navCollapsed, setNavCollapsed] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const [batch, setBatch] = useState<BatchPoll | null>(null);
  const [submittedCount, setSubmittedCount] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [csvFileName, setCsvFileName] = useState<string | null>(null);
  const csvAddressesRef = useRef<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  /* Restauration de session : le batch en cours (polling repris au montage). */
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as { batch: BatchPoll };
      if (saved?.batch) setBatch(saved.batch);
    } catch {
      /* entrée corrompue — ignorée */
    }
  }, []);

  /* Polling tant que le lot est pending. */
  useEffect(() => {
    if (!batch || batch.status === 'done') return;
    let cancelled = false;
    const id = window.setInterval(async () => {
      try {
        const resp = await fetch(`${API}/diagnostic/batch/${batch.batch_id}`);
        if (!resp.ok || cancelled) return;
        const next = (await resp.json()) as BatchPoll;
        if (!cancelled) setBatch(next);
      } catch {
        /* réseau momentané — on retente au tick suivant */
      }
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [batch?.batch_id, batch?.status]);

  async function handleFile(f: File) {
    setError(null);
    setCsvFileName(f.name);
    const text = await f.text();
    const addresses = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.toLowerCase().startsWith('adresse'));
    csvAddressesRef.current = addresses;
    await submit(addresses);
  }

  async function submit(addresses: string[]) {
    if (!addresses.length) {
      setError('Aucune adresse dans le fichier.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const resp = await fetch(`${API}/diagnostic/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addresses }),
      });
      if (!resp.ok) {
        let detail = `Erreur ${resp.status}`;
        try {
          const err = await resp.json();
          detail = err.detail?.error || err.detail?.detail || detail;
          if (err.detail?.error === 'budget_epuise') detail = err.detail.detail || detail;
        } catch {
          /* corps non-JSON */
        }
        setError(detail);
        return;
      }
      const submitResp = (await resp.json()) as { batch_id: string; n_accepted: number };
      setSubmittedCount(submitResp.n_accepted);
      const initial: BatchPoll = {
        batch_id: submitResp.batch_id,
        status: 'pending',
        results: [],
        item_errors: [],
      };
      setBatch(initial);
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ batch: initial }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur de soumission du lot.');
    } finally {
      setSubmitting(false);
    }
  }

  /* ── Dérivés ── */
  const results = batch?.results ?? [];
  const itemErrors = batch?.item_errors ?? [];
  const doneCount = results.length + itemErrors.length;

  const histogram = RESOLUTION_BANDS.map((band) => ({
    band,
    count: results.filter((r) => finestResolution(r) === band.key).length,
  }));
  const histogramMax = Math.max(1, ...histogram.map((h) => h.count));
  const needsReview = results.filter(needsExpertReview).length;

  const points: PortfolioPoint[] = results
    .filter((r) => Number.isFinite(r.adresse.lat) && Number.isFinite(r.adresse.lon))
    .map((r) => ({
      lat: r.adresse.lat,
      lon: r.adresse.lon,
      label: r.adresse.normalisee || r.adresse.saisie,
      resolution: finestResolution(r),
    }));
  const showHeatmap = points.length > 0;

  function exportCsv() {
    if (!batch) return;
    const header = 'adresse;aleas_au_batiment;resolution_la_plus_fine;a_expertiser;statut';
    const rows = results.map((r) => {
      const perBuilding = r.aleas.filter((a) => a.resolution === 'per-building').length;
      const res = finestResolution(r);
      const badge = res ? RESOLUTION_BADGES[res] : null;
      return [
        `"${(r.adresse.normalisee || r.adresse.saisie).replace(/"/g, '""')}"`,
        String(perBuilding),
        badge?.label ?? '',
        needsExpertReview(r) ? 'OUI' : '',
        'OK',
      ].join(';');
    });
    for (const e of itemErrors) {
      rows.push([`"${e.adresse.replace(/"/g, '""')}"`, '', '', '', `Erreur : ${e.erreur}`].join(';'));
    }
    const a = document.createElement('a');
    a.href =
      'data:text/csv;charset=utf-8,' +
      encodeURIComponent('\uFEFF' + [header, ...rows].join('\n'));
    a.download = `portfolio_typhoon_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  }

  async function exportPdf() {
    if (!batch) return;
    const { exportPortfolioPdf } = await import('../zone/pdf-export');
    await exportPortfolioPdf({
      items: [
        ...results.map((r) => ({
          address: r.adresse.saisie,
          status: 'completed',
          result: {
            adresse: { normalisee: r.adresse.normalisee },
            aleas: r.aleas.map((a) => ({
              code: a.code,
              libelle: a.libelle,
              present: a.present,
              resolution: a.resolution,
            })),
            erreurs_partielles: r.erreurs_partielles ?? [],
          },
        })),
        ...itemErrors.map((e) => ({
          address: e.adresse,
          status: 'failed',
          result: null,
        })),
      ],
      histogram: histogram.map((h) => ({
        key: h.band.key,
        label: h.band.label,
        color: h.band.color,
        count: h.count,
      })),
      total: submittedCount || doneCount,
      completed: results.length,
      failed: itemErrors.length,
    });
  }

  const progressPct =
    submittedCount > 0 ? Math.round((doneCount / submittedCount) * 100) : 0;

  return (
    <main
      className={`zone-app portfolio-page${theme === 'light' ? ' theme-light' : ''}${
        navCollapsed && !isMobile ? ' nav-collapsed' : ''
      }${drawerOpen ? ' drawer-open' : ''}`}
      style={{ '--accent': accent } as CSSProperties}
    >
      <ZoneSidenav
        sidenavRef={useRef<HTMLElement | null>(null)}
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
        onNavigateSettings={(tab: string) => { setDrawerOpen(false); navigate(`/settings/${tab}`); }}
        onSignOut={() => { void signOut(); setDrawerOpen(false); navigate('/'); }}
        onCloseDrawer={() => setDrawerOpen(false)}
        onNewDiagnostic={() => { setDrawerOpen(false); navigate('/zone'); }}
        onNavigate={(path: string) => { setDrawerOpen(false); navigate(path); }}
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
                Analysez un livre d'adresses en lot : import CSV, résolutions
                par bâtiment, cartographie et exports.
              </p>
            </div>
            <md-filled-button onClick={() => navigate('/zone')}>
              <md-icon slot="icon">science</md-icon>
              Nouveau diagnostic
            </md-filled-button>
          </header>

          {/* ── Import CSV (zone de dépôt) ── */}
          <section
            className={`portfolio-dropzone${dragOver ? ' drag-over' : ''}${csvFileName ? ' has-file' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files?.[0];
              if (f) void handleFile(f);
            }}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            aria-label="Importer un fichier CSV d'adresses"
          >
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
            <div className="portfolio-dropzone-icon">
              <md-icon>{submitting ? 'hourglass_top' : 'cloud_upload'}</md-icon>
            </div>
            <div className="portfolio-dropzone-copy">
              <h2>
                {submitting
                  ? 'Soumission du lot…'
                  : csvFileName
                    ? `Fichier chargé : ${csvFileName}`
                    : 'Déposer un fichier CSV'}
              </h2>
              <p>
                {submitting
                  ? "Le lot est en cours d'envoi au moteur de diagnostic."
                  : csvFileName
                    ? 'Cliquez pour remplacer le fichier — un CSV, une colonne « adresse » par ligne.'
                    : 'Ou cliquez pour parcourir — CSV avec une colonne « adresse » (une adresse par ligne).'}
              </p>
            </div>
            {submitting && (
              <md-circular-progress indeterminate aria-label="Soumission en cours" />
            )}
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
              {/* Cartes de stats */}
              <section className="dash-stats" aria-label="Résumé du lot">
                <div className="dash-stat-card">
                  <span className="dash-stat-icon dash-icon-blue"><md-icon>inbox</md-icon></span>
                  <span className="dash-stat-label">Adresses</span>
                  <span className="dash-stat-value">{submittedCount || doneCount}</span>
                  <span className="dash-stat-sub">dans le lot</span>
                </div>
                <div className="dash-stat-card">
                  <span className="dash-stat-icon dash-icon-green"><md-icon>check_circle</md-icon></span>
                  <span className="dash-stat-label">Diagnostiquées</span>
                  <span className="dash-stat-value">{results.length}</span>
                  <span className="dash-stat-sub">enregistrements complets</span>
                </div>
                <div className="dash-stat-card">
                  <span className="dash-stat-icon dash-icon-orange"><md-icon>warning</md-icon></span>
                  <span className="dash-stat-label">À expertiser</span>
                  <span className="dash-stat-value">{needsReview}</span>
                  <span className="dash-stat-sub">estimation communale uniquement</span>
                </div>
                <div className="dash-stat-card">
                  <span className="dash-stat-icon dash-icon-red"><md-icon>error</md-icon></span>
                  <span className="dash-stat-label">En erreur</span>
                  <span className="dash-stat-value">{itemErrors.length}</span>
                  <span className="dash-stat-sub">adresse non reconnue</span>
                </div>
              </section>

              {/* Progression */}
              {batch.status === 'pending' && (
                <div className="portfolio-progress">
                  <div className="portfolio-progress-row">
                    <span><md-icon>sync</md-icon> Traitement du lot en cours…</span>
                    <strong>{progressPct}%</strong>
                  </div>
                  <div className="portfolio-progress-track">
                    <div className="portfolio-progress-fill" style={{ width: `${progressPct}%` }} />
                  </div>
                </div>
              )}
              {batch.status === 'done' && (
                <div className="portfolio-progress done">
                  <div className="portfolio-progress-row">
                    <span><md-icon>check_circle</md-icon> Lot terminé</span>
                    <strong>{doneCount}/{submittedCount || doneCount}</strong>
                  </div>
                </div>
              )}

              {/* ── Histogramme des résolutions ── */}
              <section className="portfolio-histogram" aria-label="Histogramme des résolutions">
                <div className="dash-panel-head">
                  <h2>Répartition par qualité de résolution</h2>
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
                {histogramMax <= 1 && results.length === 0 && (
                  <p className="portfolio-hist-empty">Aucun résultat terminé pour l'instant.</p>
                )}
              </section>

              {/* ── Heatmap ── */}
              {showHeatmap && (
                <section className="portfolio-map">
                  <h2>Cartographie du livre</h2>
                  <div className="portfolio-map-wrap">
                    <UnifiedMap report={null} points={points} initial3D={false} />
                  </div>
                </section>
              )}

              {/* ── Tableau ── */}
              <section className="portfolio-table-section">
                <div className="portfolio-table-head">
                  <h2>Détail par adresse</h2>
                  <span className={`portfolio-status ${batch.status}`}>
                    {batch.status === 'done' ? (
                      <><md-icon>check_circle</md-icon> Terminé</>
                    ) : (
                      <><md-icon>sync</md-icon> En cours…</>
                    )}
                  </span>
                </div>
                <div className="portfolio-table-scroll">
                  <table className="portfolio-table">
                    <thead>
                      <tr>
                        <th>Adresse</th>
                        <th>Aléas au bâtiment</th>
                        <th>Résolution la plus fine</th>
                        <th>À expertiser</th>
                        <th>Statut</th>
                      </tr>
                    </thead>
                    <tbody>
                      {results.map((r, i) => {
                        const perBuilding = r.aleas.filter((a) => a.resolution === 'per-building').length;
                        const res = finestResolution(r);
                        const badge = res ? RESOLUTION_BADGES[res] : null;
                        const review = needsExpertReview(r);
                        return (
                          <tr key={`${r.adresse.citycode}-${i}`}>
                            <td className="portfolio-cell-addr" title={r.adresse.normalisee}>
                              {r.adresse.normalisee || r.adresse.saisie}
                            </td>
                            <td>{perBuilding}</td>
                            <td>
                              {badge ? (
                                <span className={`d03-pill ${badge.cls}`} title={badge.title}>{badge.label}</span>
                              ) : (
                                '—'
                              )}
                            </td>
                            <td>{review ? <span className="portfolio-review-flag">À expertiser</span> : ''}</td>
                            <td><span className="portfolio-item-status completed">OK</span></td>
                          </tr>
                        );
                      })}
                      {itemErrors.map((e, i) => (
                        <tr key={`err-${i}`}>
                          <td className="portfolio-cell-addr">{e.adresse}</td>
                          <td>—</td>
                          <td>—</td>
                          <td></td>
                          <td><span className="portfolio-item-status failed">Erreur</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {itemErrors.length > 0 && (
                  <p className="portfolio-partial-note">
                    Certaines adresses n'ont pas pu être analysées — elles n'affectent pas le reste
                    du lot.
                  </p>
                )}
              </section>
            </>
          )}

          {!batch && !submitting && (
            <section className="portfolio-empty">
              <md-icon>dashboard</md-icon>
              <h2>Aucun lot chargé</h2>
              <p>Déposez un fichier CSV d'adresses pour lancer l'analyse du livre.</p>
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
