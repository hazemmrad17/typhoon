// =============================================================================
//   TYPHOON — /watchlist : communes/adresses suivies (Ticket 5 — insurerpagesplan)
//   Page pleine (même chrome que /dashboard et /portfolio) rendant une liste
//   de cartes Material : chaque entrée porte son adresse, son code INSEE, le
//   nombre d'arrêtés CatNat vus, un badge « nouveau CatNat » quand la commune
//   a plus d'arrêtés que lors de la dernière visite — et un bouton de retrait.
// =============================================================================

import { useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { CSSProperties } from 'react';
import { ZoneSidenav, useIsMobile } from '../components/ZoneSidenav';
import { useTyphoonTheme } from '../typhoon/useTyphoonTheme';
import { useUserProfile } from '../typhoon/useUserProfile';
import { useAuth } from '../typhoon/auth';
import {
  loadCatNatLatest,
  loadWatchlist,
  markAllCatNatSeen,
  newCatNatCount,
  removeFromWatchlist,
  saveWatchlist,
  type WatchlistEntry,
} from '../zone/watchlist';
import '../styles/zone.css';

export function WatchlistPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { theme, accent, mode, setThemeMode } = useTyphoonTheme();
  const { profile } = useUserProfile();
  const { signOut } = useAuth();
  const isMobile = useIsMobile();

  const [navCollapsed, setNavCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const sidenavRef = useRef<HTMLElement | null>(null);

  const [entries, setEntries] = useState<WatchlistEntry[]>(() => loadWatchlist());
  const [catNatLatest] = useState<Record<string, number>>(() => loadCatNatLatest());

  const handleRemove = (id: string) => {
    setEntries((prev) => {
      const next = removeFromWatchlist(prev, id);
      saveWatchlist(next);
      return next;
    });
  };

  const handleOpen = (address: string) => {
    /* Visite explicite → tout marquer vu pour cette adresse (le diagnostic
       qui suit mettra à jour la référence via recordCatNatLatest). */
    setEntries((prev) => {
      const key = address.trim().toLowerCase();
      const next = prev.map((e) =>
        e.address.toLowerCase() === key
          ? { ...e, lastSeenCatNat: catNatLatest[key] ?? e.lastSeenCatNat }
          : e
      );
      saveWatchlist(next);
      return next;
    });
    setDrawerOpen(false);
    navigate(`/zone?q=${encodeURIComponent(address)}`);
  };

  const newCatNat = newCatNatCount(entries, catNatLatest);

  return (
    <main
      className={`zone-app watchlist-page${theme === 'light' ? ' theme-light' : ''}${
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
              <h1>Watchlist</h1>
              <p>
                Suivez les adresses d'intérêt et soyez alerté des nouveaux
                arrêtés CatNat de leur commune.
              </p>
            </div>
            {newCatNat > 0 && (
              <md-filled-button onClick={() => handleMarkAllSeen()}>
                <md-icon slot="icon">done_all</md-icon>
                Tout marquer vu
              </md-filled-button>
            )}
          </header>

          {/* ── Cartes de stats ── */}
          <section className="dash-stats" aria-label="Statistiques de la watchlist">
            <div className="dash-stat-card">
              <span className="dash-stat-icon dash-icon-blue"><md-icon>bookmarks</md-icon></span>
              <span className="dash-stat-label">Adresses suivies</span>
              <span className="dash-stat-value">{entries.length}</span>
              <span className="dash-stat-sub">dans la watchlist</span>
            </div>
            <div className="dash-stat-card">
              <span className="dash-stat-icon dash-icon-red"><md-icon>notifications_active</md-icon></span>
              <span className="dash-stat-label">Nouveaux CatNat</span>
              <span className="dash-stat-value">{newCatNat}</span>
              <span className="dash-stat-sub">alertes depuis la dernière visite</span>
            </div>
          </section>

          {entries.length === 0 ? (
            <section className="portfolio-empty">
              <md-icon>bookmark_border</md-icon>
              <h2>Watchlist vide</h2>
              <p>
                Depuis la carte de décision, cliquez «&nbsp;Ajouter à la
                watchlist&nbsp;» pour suivre une adresse et être alerté des
                nouveaux arrêtés CatNat de sa commune.
              </p>
              <md-filled-button onClick={() => navigate('/zone')}>
                <md-icon slot="icon">science</md-icon>
                Lancer un diagnostic
              </md-filled-button>
            </section>
          ) : (
            <section className="watchlist-grid" aria-label="Adresses suivies">
              {entries.map((e) => {
                const key = e.address.trim().toLowerCase();
                const latest = catNatLatest[key];
                const hasNew = latest != null && latest > (e.lastSeenCatNat || 0);
                return (
                  <div className={`watchlist-card${hasNew ? ' has-new' : ''}`} key={e.id}>
                    <div className="watchlist-card-top">
                      <span className={`watchlist-card-icon${hasNew ? ' alert' : ''}`}>
                        <md-icon>{hasNew ? 'notifications_active' : 'bookmark'}</md-icon>
                      </span>
                      <div className="watchlist-card-title">
                        <h3 title={e.address}>{e.address}</h3>
                        {e.citycode && <span className="watchlist-card-insee">INSEE {e.citycode}</span>}
                      </div>
                      <md-icon-button
                        className="watchlist-card-remove"
                        aria-label={`Retirer ${e.address} de la watchlist`}
                        title="Retirer de la watchlist"
                        onClick={() => handleRemove(e.id)}
                      >
                        <md-icon>close</md-icon>
                      </md-icon-button>
                    </div>
                    <div className="watchlist-card-foot">
                      {hasNew ? (
                        <span className="watchlist-card-badge alert" title="Nouveaux arrêtés CatNat depuis la dernière visite">
                          <md-icon>notifications_active</md-icon>
                          {latest} arrêté{latest > 1 ? 's' : ''} CatNat
                        </span>
                      ) : e.lastSeenCatNat > 0 ? (
                        <span className="watchlist-card-badge">
                          <md-icon>verified_user</md-icon>
                          {e.lastSeenCatNat} arrêté{e.lastSeenCatNat > 1 ? 's' : ''} CatNat
                        </span>
                      ) : (
                        <span className="watchlist-card-badge muted">
                          <md-icon>schedule</md-icon>
                          En attente de diagnostic
                        </span>
                      )}
                      <md-text-button
                        className="watchlist-card-open"
                        onClick={() => handleOpen(e.address)}
                      >
                        Diagnostiquer
                      </md-text-button>
                    </div>
                  </div>
                );
              })}
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

  function handleMarkAllSeen() {
    setEntries((prev) => {
      const next = markAllCatNatSeen(prev, catNatLatest);
      saveWatchlist(next);
      return next;
    });
  }
}
