// =============================================================================
//   TYPHOON — /dashboard : vue d'ensemble de l'assureur
//   Tableau de bord façon « PolicyPilot » (Material Web) — alimenté par les
//   données déjà présentes en local (cache des diagnostics, watchlist,
//   références CatNat) : aucun appel réseau supplémentaire.
//
//   Layout (réf. PolicyPilot) : cartes de stats en haut → grille à deux
//   colonnes : tableau « Derniers diagnostics » (large, avec barre d'actions)
//   à gauche ; à droite deux panneaux empilés — « Répartition par bande D03 »
//   (barre segmentée + mini-métriques + alerte) puis « File de validation »
//   (dégradé bleu).
// =============================================================================

import { useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { CSSProperties } from 'react';
import { ZoneSidenav, useIsMobile } from '../components/ZoneSidenav';
import { useTyphoonTheme } from '../typhoon/useTyphoonTheme';
import { useUserProfile } from '../typhoon/useUserProfile';
import { useAuth } from '../typhoon/auth';
import { D03, bandForKey } from '../zone/config';
import { loadCache } from '../zone/diagnosticCache';
import {
  loadCatNatLatest,
  loadWatchlist,
  newCatNatCount,
  type WatchlistEntry,
} from '../zone/watchlist';
import '../styles/zone.css';

/** Déduit la bande D03 d'un diagnostic caché (pire aléa présent). */
function bandForCacheEntry(entry: {
  report: { aleas?: { present?: boolean | null; niveau?: string | null }[] };
}) {
  const levels = (entry.report.aleas ?? []).filter((a) => a.present).map((a) => a.niveau ?? '');
  const worst = levels.find((n) => n === 'critique') ?? levels.find((n) => n === 'eleve');
  if (worst) return bandForKey(worst);
  const modere = levels.find((n) => n === 'modere');
  if (modere) return bandForKey(modere);
  return undefined;
}

export function Dashboard() {
  const navigate = useNavigate();
  const location = useLocation();
  const { theme, accent, mode, setThemeMode } = useTyphoonTheme();
  const { profile } = useUserProfile();
  const { signOut } = useAuth();
  const isMobile = useIsMobile();

  const [navCollapsed, setNavCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const sidenavRef = useRef<HTMLElement | null>(null);

  const [entries] = useState<WatchlistEntry[]>(() => loadWatchlist());
  const [catNatLatest] = useState<Record<string, number>>(() => loadCatNatLatest());
  const [cache] = useState(() => loadCache());
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'recent' | 'bande' | 'adresse'>('recent');
  const [bandAlertDismissed, setBandAlertDismissed] = useState(false);

  /* ── Statistiques ── */
  const diagnostics = cache.length;
  const aExpertiser = cache.filter(
    (c) => bandForCacheEntry(c)?.key === 'eleve' || bandForCacheEntry(c)?.key === 'critique'
  ).length;
  const suivies = entries.length;
  const newCatNat = newCatNatCount(entries, catNatLatest);

  /* ── Répartition par bande D03 (diagnostics cachés) ── */
  const byBand = D03.map((b) => ({
    band: b,
    count: cache.filter((c) => bandForCacheEntry(c)?.key === b.key).length,
  }));
  const bandTotal = Math.max(1, byBand.reduce((s, x) => s + x.count, 0));

  /* ── Derniers diagnostics : filtre + tri ── */
  const recent = [...cache]
    .filter((c) => {
      if (!search) return true;
      const q = search.trim().toLowerCase();
      return (c.report.adresse_normalisee || c.report.adresse_saisie).toLowerCase().includes(q);
    })
    .sort((a, b) => {
      if (sortBy === 'adresse') return (a.report.adresse_normalisee || '').localeCompare(b.report.adresse_normalisee || '');
      if (sortBy === 'bande') {
        const ka = bandForCacheEntry(a)?.key ?? '';
        const kb = bandForCacheEntry(b)?.key ?? '';
        return kb.localeCompare(ka);
      }
      return b.createdAt - a.createdAt;
    })
    .slice(0, 8);

  return (
    <main
      className={`zone-app dashboard-page${theme === 'light' ? ' theme-light' : ''}${
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
        onSignOut={() => { void signOut(); setDrawerOpen(false); navigate('/'); }}
        onCloseDrawer={() => setDrawerOpen(false)}
        onNewDiagnostic={() => { setDrawerOpen(false); navigate('/zone'); }}
        onNavigate={(path) => { setDrawerOpen(false); navigate(path); }}
      />

      <div className="zone-main">
        <div className="portfolio-scroll dashboard-scroll">
          <header className="portfolio-header dashboard-header">
            <md-icon-button
              className="sidenav-hamburger account-settings-hamburger"
              aria-label="Ouvrir le menu"
              onClick={() => setDrawerOpen(true)}
            >
              <md-icon>menu</md-icon>
            </md-icon-button>
            <div className="account-settings-title">
              <h1>Dashboard</h1>
              <p>
                Vue d'ensemble de votre portefeuille : diagnostics, risques à
                expertiser, communes suivies et alertes CatNat.
              </p>
            </div>
            <md-filled-button onClick={() => navigate('/zone')}>
              <md-icon slot="icon">add</md-icon>
              Nouveau diagnostic
            </md-filled-button>
          </header>

          {/* ── Cartes de statistiques ── */}
          <section className="dash-stats" aria-label="Statistiques">
            <div className="dash-stat-card">
              <span className="dash-stat-icon dash-icon-green"><md-icon>check_circle</md-icon></span>
              <span className="dash-stat-label">Diagnostics</span>
              <span className="dash-stat-value">{diagnostics}</span>
              <span className="dash-stat-sub">réalisés sur les 30 derniers</span>
            </div>
            <div className="dash-stat-card">
              <span className="dash-stat-icon dash-icon-orange"><md-icon>warning</md-icon></span>
              <span className="dash-stat-label">À expertiser</span>
              <span className="dash-stat-value">{aExpertiser}</span>
              <span className="dash-stat-sub">bande Élevé / Critique</span>
            </div>
            <div className="dash-stat-card">
              <span className="dash-stat-icon dash-icon-blue"><md-icon>bookmarks</md-icon></span>
              <span className="dash-stat-label">Adresses suivies</span>
              <span className="dash-stat-value">{suivies}</span>
              <span className="dash-stat-sub">watchlist active</span>
            </div>
            <div className="dash-stat-card">
              <span className="dash-stat-icon dash-icon-red"><md-icon>notifications_active</md-icon></span>
              <span className="dash-stat-label">Nouveaux CatNat</span>
              <span className="dash-stat-value">{newCatNat}</span>
              <span className="dash-stat-sub">alertes depuis la dernière visite</span>
            </div>
          </section>

          {/* ── Grille à deux colonnes : tableau (gauche) + panneaux (droite) ── */}
          <div className="dash-grid">
            {/* Colonne gauche : Derniers diagnostics */}
            <section className="dash-panel dash-recent">
              <div className="dash-panel-head">
                <h2>Derniers diagnostics</h2>
                <md-text-button onClick={() => navigate('/zone')}>
                  Tout voir
                </md-text-button>
              </div>
              {/* Barre d'actions (comme la réf. PolicyPilot) */}
              <div className="dash-toolbar">
                <div className="dash-toolbar-actions">
                  <md-filled-button onClick={() => navigate('/portfolio')}>
                    <md-icon slot="icon">download</md-icon>
                    Import
                  </md-filled-button>
                  <md-text-button onClick={() => navigate('/watchlist')}>
                    Watchlist
                  </md-text-button>
                </div>
                <div className="dash-toolbar-controls">
                  <div className="dash-search">
                    <md-icon>search</md-icon>
                    <input
                      type="search"
                      placeholder="Rechercher…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      aria-label="Rechercher une adresse"
                    />
                  </div>
                  <select
                    className="dash-sort"
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                    aria-label="Trier par"
                  >
                    <option value="recent">Plus récent</option>
                    <option value="bande">Bande D03</option>
                    <option value="adresse">Adresse</option>
                  </select>
                </div>
              </div>
              {recent.length === 0 ? (
                <div className="dash-empty">
                  <md-icon>search</md-icon>
                  <p>
                    {search
                      ? 'Aucune adresse ne correspond à votre recherche.'
                      : "Aucun diagnostic pour l'instant. Lancez une analyse depuis la zone."}
                  </p>
                </div>
              ) : (
                <div className="dash-table-scroll">
                  <table className="dash-table">
                    <thead>
                      <tr>
                        <th>Adresse</th>
                        <th>Bande D03</th>
                        <th>À expertiser</th>
                        <th>Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recent.map((c) => {
                        const band = bandForCacheEntry(c);
                        return (
                          <tr
                            key={c.key}
                            className="dash-row-click"
                            onClick={() => navigate(`/zone?q=${encodeURIComponent(c.report.adresse_normalisee || c.report.adresse_saisie)}`)}
                          >
                            <td className="dash-cell-addr" title={c.report.adresse_normalisee}>
                              {c.report.adresse_normalisee || c.report.adresse_saisie}
                            </td>
                            <td>
                              {band ? (
                                <span className={`d03-pill ${band.cls}`}>{band.label}</span>
                              ) : (
                                <span className="dash-band-none">—</span>
                              )}
                            </td>
                            <td>
                              {band?.key === 'eleve' || band?.key === 'critique' ? (
                                <span className="dash-flag">À expertiser</span>
                              ) : (
                                <span className="dash-band-none">—</span>
                              )}
                            </td>
                            <td className="dash-date">
                              {new Date(c.createdAt).toLocaleDateString('fr-FR', {
                                day: '2-digit',
                                month: 'short',
                                year: 'numeric',
                              })}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* Colonne droite : panneaux empilés */}
            <div className="dash-side">
              {/* Répartition par bande D03 (comme « Document Compliance ») */}
              <section className="dash-panel dash-bands">
                <div className="dash-panel-head">
                  <h2>Répartition par bande D03</h2>
                  <md-text-button onClick={() => navigate('/portfolio')}>
                    Portfolio
                  </md-text-button>
                </div>
                <div className="dash-band-bar">
                  {byBand.map(({ band, count }) => (
                    <div
                      key={band.key}
                      className="dash-band-seg"
                      style={{ width: `${(count / bandTotal) * 100}%`, background: band.color }}
                      title={`${band.label} : ${count}`}
                    />
                  ))}
                </div>
                <div className="dash-band-mini">
                  {byBand.filter((x) => x.count > 0).map(({ band, count }) => (
                    <div className="dash-band-mini-item" key={band.key}>
                      <span className="dash-band-dot" style={{ background: band.color }} />
                      <strong>{count}</strong>
                      <span>{band.label}</span>
                    </div>
                  ))}
                  {byBand.every((x) => x.count === 0) && (
                    <span className="dash-band-none">Aucun diagnostic classé</span>
                  )}
                </div>
                <div className="dash-band-metrics">
                  <div className="dash-band-metric">
                    <span className="dash-band-metric-num">{diagnostics}</span>
                    <span className="dash-band-metric-label">Diagnostics</span>
                  </div>
                  <div className="dash-band-metric">
                    <span className="dash-band-metric-num">{aExpertiser}</span>
                    <span className="dash-band-metric-label">À expertiser</span>
                  </div>
                </div>
                {aExpertiser > 0 && !bandAlertDismissed && (
                  <div className="dash-band-alert">
                    <md-icon>priority_high</md-icon>
                    <span>
                      {aExpertiser} diagnostic{aExpertiser > 1 ? 's' : ''} en bande Élevé ou
                      Critique — à revoir pour éviter les retards de souscription.
                    </span>
                    <md-icon-button
                      className="dash-band-alert-close"
                      aria-label="Fermer"
                      onClick={() => setBandAlertDismissed(true)}
                    >
                      <md-icon>close</md-icon>
                    </md-icon-button>
                  </div>
                )}
              </section>

              {/* File de validation (dégradé bleu, comme « Storage Usage ») */}
              <section className="dash-validation">
                <div className="dash-validation-head">
                  <h2>File de validation</h2>
                  <md-text-button onClick={() => navigate('/watchlist')}>
                    Voir la watchlist
                  </md-text-button>
                </div>
                <div className="dash-validation-grid">
                  <div className="dash-validation-card" onClick={() => navigate('/portfolio')}>
                    <md-icon>pie_chart</md-icon>
                    <span className="dash-validation-count">{aExpertiser}</span>
                    <span className="dash-validation-label">À expertiser</span>
                  </div>
                  <div className="dash-validation-card" onClick={() => navigate('/watchlist')}>
                    <md-icon>notifications_active</md-icon>
                    <span className="dash-validation-count">{newCatNat}</span>
                    <span className="dash-validation-label">Nouveaux CatNat</span>
                  </div>
                  <div className="dash-validation-card" onClick={() => navigate('/portfolio')}>
                    <md-icon>bookmarks</md-icon>
                    <span className="dash-validation-count">{suivies}</span>
                    <span className="dash-validation-label">Adresses suivies</span>
                  </div>
                  <div className="dash-validation-card" onClick={() => navigate('/zone')}>
                    <md-icon>science</md-icon>
                    <span className="dash-validation-count">{diagnostics}</span>
                    <span className="dash-validation-label">Diagnostics</span>
                  </div>
                </div>
                {newCatNat > 0 && (
                  <div className="dash-validation-alert">
                    <md-icon>info</md-icon>
                    <span>
                      {newCatNat} commune{newCatNat > 1 ? 's' : ''} de votre watchlist a
                      {newCatNat > 1 ? 'ont' : ''} de nouveaux arrêtés CatNat — consultez la file
                      pour éviter les retards.
                    </span>
                  </div>
                )}
              </section>
            </div>
          </div>
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
