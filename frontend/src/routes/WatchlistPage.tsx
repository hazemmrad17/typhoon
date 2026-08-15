// =============================================================================
//   TYPHOON — /watchlist : communes/adresses suivies (Ticket 5 — insurerpagesplan)
//   Page pleine (même chrome que /portfolio) rendant WatchlistPanel, alimentée
//   par la store localStorage + la « référence » du dernier comptage CatNat
//   observé (enregistrée par /zone à chaque diagnostic — aucun appel réseau).
// =============================================================================

import { useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { CSSProperties } from 'react';
import { ZoneSidenav, useIsMobile } from '../components/ZoneSidenav';
import { WatchlistPanel } from '../components/WatchlistPanel';
import { useTyphoonTheme } from '../typhoon/useTyphoonTheme';
import { useUserProfile } from '../typhoon/useUserProfile';
import {
  loadCatNatLatest,
  loadWatchlist,
  markAllCatNatSeen,
  newCatNatCount,
  removeFromWatchlist,
  saveWatchlist,
  type WatchlistEntry,
} from '../zone/watchlist';
import {
  loadConversations,
  removeConversation,
  saveConversations,
  type Conversation,
} from '../zone/conversations';
import { removeCachedDiagnostic } from '../zone/diagnosticCache';
import '../styles/zone.css';

export function WatchlistPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { theme, accent, mode, setThemeMode } = useTyphoonTheme();
  const { profile } = useUserProfile();
  const isMobile = useIsMobile();

  const [navCollapsed, setNavCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const sidenavRef = useRef<HTMLElement | null>(null);

  const [conversations, setConversations] = useState<Conversation[]>(() => loadConversations());
  const [entries, setEntries] = useState<WatchlistEntry[]>(() => loadWatchlist());
  const [catNatLatest] = useState<Record<string, number>>(() => loadCatNatLatest());

  const handleDeleteConversation = (id: string) => {
    setConversations((prev) => {
      const victim = prev.find((c) => c.id === id);
      const next = removeConversation(prev, id);
      saveConversations(next);
      if (victim) removeCachedDiagnostic(victim.address);
      return next;
    });
  };

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

          <WatchlistPanel
            entries={entries}
            newCatNat={newCatNat}
            onOpen={handleOpen}
            onRemove={handleRemove}
          />
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
