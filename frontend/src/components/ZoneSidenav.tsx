// =============================================================================
//   TYPHOON — Sidenav rétractable partagée (/zone & /account|/settings)
//   Navigation façon Gemini : Desktop rail pleine largeur ↔ colonne d'icônes
//   (collapsed) · Mobile drawer hors-écran + scrim. Le pied d'écran porte
//   l'utilisateur (MOCK_USER) et l'engrenage « compte » : les deux mènent à
//   /settings (onglet Compte).
// =============================================================================

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { RefObject } from 'react';
import { MOCK_USER } from './mockUser';
import { useAuth, type AuthUser } from '../typhoon/auth';
import type { ThemeMode } from '../typhoon/useTyphoonTheme';
import type { UserProfile } from '../typhoon/useUserProfile';

/* ── Entrées de navigation par profil. Le Dashboard est commun à tous les
   profils (le promoteur/banque avaient perdu toute entrée quand « Nouveau
   diagnostic » a été retiré — sidebar vide). L'assurance a en plus Portfolio
   et Watchlist (Tickets 4 & 5 du plan insurerpagesplan). */
const PROFILE_NAV: Record<string, Array<{ path: string; label: string; icon: string }>> = {
  promoteur: [{ path: '/dashboard', label: 'Dashboard', icon: 'space_dashboard' }],
  assurance: [
    { path: '/dashboard', label: 'Dashboard', icon: 'space_dashboard' },
    { path: '/portfolio', label: 'Portfolio', icon: 'dashboard' },
    { path: '/watchlist', label: 'Watchlist', icon: 'bookmarks' },
  ],
  banque: [{ path: '/dashboard', label: 'Dashboard', icon: 'space_dashboard' }],
};

/* ── Menu utilisateur : onglets navigables du panneau Paramètres + déconnexion ── */
const USER_MENU_ITEMS: Array<{ tab: string; label: string; icon: string }> = [
  { tab: 'account', label: 'Mon profil', icon: 'account_circle' },
  { tab: 'security', label: 'Sécurité', icon: 'lock' },
  { tab: 'billing', label: 'Abonnement & Facturation', icon: 'credit_card' },
  { tab: 'notifications', label: 'Notifications', icon: 'notifications' },
  { tab: 'connections', label: 'Connexions', icon: 'link' },
];

/* ── Menu thème : les trois modes proposés (Clair / Sombre / Système) ── */
const THEME_MODES: Array<{ mode: ThemeMode; label: string; icon: string }> = [
  { mode: 'light', label: 'Clair', icon: 'light_mode' },
  { mode: 'dark', label: 'Sombre', icon: 'dark_mode' },
  { mode: 'system', label: 'Système', icon: 'brightness_auto' },
];

/* ── Détection mobile — 900px, même breakpoint que @media (max-width:900px)
   dans zone.css (garder les deux synchronisés) ── */
export function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 900px)');
    const onChange = () => setIsMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return isMobile;
}

export type ZoneSidenavProps = {
  sidenavRef: RefObject<HTMLElement | null>;
  collapsed: boolean;
  mobile: boolean;
  hidden: boolean;
  theme: 'dark' | 'light';
  mode: ThemeMode;
  profile?: UserProfile;
  /** Chemin actif pour surligner l'entrée de navigation courante. */
  activePath?: string;
  onThemeModeChange: (mode: ThemeMode) => void;
  onToggleCollapse: () => void;
  onOpenAccount: () => void;
  /** Navigation vers un onglet des paramètres (/settings/<tab>). */
  onNavigateSettings: (tab: string) => void;
  /** Déconnexion (retour à l'accueil). */
  onSignOut: () => void;
  onCloseDrawer: () => void;
  onNewDiagnostic: () => void;
  /** Navigation interne (Portfolio / Watchlist…). */
  onNavigate?: (path: string) => void;
};

/* ── Sidenav rétractable (navigation façon Gemini) ──
   Desktop : rail pleine largeur ↔ colonne d'icônes (collapsed).
   Mobile  : drawer hors-écran ouvert via le hamburger + scrim. */
export function ZoneSidenav({
  sidenavRef,
  collapsed,
  mobile,
  hidden,
  theme,
  mode,
  profile,
  activePath,
  onThemeModeChange,
  onToggleCollapse,
  onOpenAccount,
  onNavigateSettings,
  onSignOut,
  onCloseDrawer,
  onNavigate,
}: ZoneSidenavProps) {
  /* Utilisateur réel (Supabase) — retombe sur MOCK_USER si non connecté
     (mode démo ou tests sans provider). */
  const { user } = useAuth();
  const currentUser: AuthUser | null = user;
  const displayUser = currentUser ?? {
    name: MOCK_USER.name,
    initials: MOCK_USER.initials,
    email: MOCK_USER.email,
    organization: MOCK_USER.organization,
    tier: MOCK_USER.tier,
    profile: MOCK_USER.profile,
    id: 'mock',
  };

  const profileNav = (profile ? PROFILE_NAV[profile] : undefined) || [];
  /* Mode replié : STRICTEMENT la colonne d'icônes — aucun libellé, et aucun
     dépliage au survol (les intitulés restent accessibles en infobulle via
     `title`). Le dépliage durable passe uniquement par le toggle. */
  const effectiveCollapsed = collapsed;
  /* Déplié durablement (épinglé) : l'aside reste ouverte après un clic. */
  const pinned = !mobile && !collapsed;

  /* ── Menu utilisateur (dropdown du pied de sidenav) ── */
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userBtnRef = useRef<HTMLButtonElement | null>(null);
  const userMenuRef = useRef<HTMLDivElement | null>(null);

  /* ── Menu thème (Clair / Sombre / Système) ── */
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const themeBtnRef = useRef<HTMLButtonElement | null>(null);
  const themeMenuRef = useRef<HTMLDivElement | null>(null);

  /* Clic extérieur + Échap ferment le menu ; repli de la sidenav aussi. */
  useEffect(() => {
    if (!userMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (userMenuRef.current?.contains(t)) return;
      if (userBtnRef.current?.contains(t)) return;
      setUserMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setUserMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [userMenuOpen]);

  useEffect(() => {
    setUserMenuOpen(false);
  }, [effectiveCollapsed]);

  /* Clic extérieur + Échap ferment le menu thème ; repli de la sidenav aussi. */
  useEffect(() => {
    if (!themeMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (themeMenuRef.current?.contains(t)) return;
      if (themeBtnRef.current?.contains(t)) return;
      setThemeMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setThemeMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [themeMenuOpen]);

  useEffect(() => {
    setThemeMenuOpen(false);
  }, [effectiveCollapsed]);

  return (
    <aside
      ref={sidenavRef}
      className="zone-sidenav"
      aria-label="Navigation principale"
      inert={hidden}
      aria-hidden={hidden}
    >
      <header className="sidenav-header">
        <Link
          to="/"
          className="sidenav-brand"
          aria-label="Typhon — accueil"
          onClick={onCloseDrawer}
        >
          {/* Logo : ICON MARK (icône seule) en version mini du tiroir, le
              wordmark complet quand il est déplié. Les deux sont des masques
              alpha teintés par --md-sys-color-primary (voir zone.css). */}
          <span
            className={collapsed ? 'sidenav-iconmark-img' : 'sidenav-wordmark-img'}
            aria-hidden="true"
          />
        </Link>
        {/* Toggle à 2 états (desktop) :
            1. Repliée → hamburger (clic = déplier) ;
            2. Épinglée → menu_open pleine/adherente, l'aside demeure dépliée. */}
        <md-icon-button
          className={`sidenav-toggle${pinned ? ' sidenav-toggle--pinned' : ''}`}
          aria-label={
            mobile
              ? 'Fermer le menu'
              : effectiveCollapsed
                ? 'Déplier le menu'
                : 'Replier le menu'
          }
          title={
            mobile
              ? 'Fermer le menu'
              : effectiveCollapsed
                ? 'Déplier le menu'
                : 'Replier le menu'
          }
          onClick={onToggleCollapse}
        >
          <md-icon>
            {mobile ? 'close' : effectiveCollapsed ? 'menu' : 'menu_open'}
          </md-icon>
        </md-icon-button>
      </header>

      {effectiveCollapsed ? (
        /* ── Mode replié : colonne d'icônes, sans libellé ── */
        <nav className="sidenav-rail" aria-label="Raccourcis">
          {profileNav.map((item) => (
            <md-icon-button
              key={item.path}
              className={activePath === item.path ? ' sidenav-rail-active' : ''}
              title={item.label}
              aria-label={item.label}
              onClick={() => onNavigate?.(item.path)}
            >
              <md-icon>{item.icon}</md-icon>
            </md-icon-button>
          ))}
        </nav>
      ) : (
        /* ── Mode déplié : liste M3, centrée verticalement ── */
        <div className="sidenav-body">
          <md-list className="sidenav-nav">
            {profileNav.map((item) => (
              <md-list-item
                key={item.path}
                className={`sidenav-nav-item${activePath === item.path ? ' active' : ''}`}
                type="button"
                onClick={() => onNavigate?.(item.path)}
              >
                <md-icon slot="start">{item.icon}</md-icon>
                <span slot="headline">{item.label}</span>
              </md-list-item>
            ))}
          </md-list>
        </div>
      )}

      <footer className="sidenav-footer">
        {/* Rangée du haut : sélecteur de thème (Clair / Sombre / Système) —
            bouton avec libellé quand la sidenav est dépliée, icône seule dans
            le rail. Le libellé reflète le thème effectif. */}
        <div className="sidenav-footer-top">
          <div className="sidenav-theme">
            <button
              type="button"
              className="sidenav-theme-btn"
              ref={themeBtnRef}
              aria-label="Changer de thème"
              title="Changer de thème"
              aria-haspopup="menu"
              aria-expanded={themeMenuOpen}
              onClick={() => setThemeMenuOpen((o) => !o)}
            >
              <md-icon>{theme === 'dark' ? 'dark_mode' : 'light_mode'}</md-icon>
              <span className="sidenav-theme-label">
                {theme === 'dark' ? 'Sombre' : 'Clair'}
              </span>
            </button>

            {themeMenuOpen && (
              <div
                className="sidenav-theme-menu"
                ref={themeMenuRef}
                role="menu"
                aria-label="Choix du thème"
              >
                {THEME_MODES.map((item) => (
                  <button
                    key={item.mode}
                    type="button"
                    role="menuitemradio"
                    aria-checked={mode === item.mode}
                    className={`sidenav-theme-menu-item${mode === item.mode ? ' active' : ''}`}
                    onClick={() => {
                      setThemeMenuOpen(false);
                      onThemeModeChange(item.mode);
                    }}
                  >
                    <md-icon>{item.icon}</md-icon>
                    <span>{item.label}</span>
                    {mode === item.mode && (
                      <md-icon className="sidenav-theme-menu-check">check</md-icon>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        {/* Rangée du bas : utilisateur + réglages (compte) */}
        <div className="sidenav-footer-main">
          <button
            type="button"
            className="sidenav-user"
            ref={userBtnRef}
            title={`Compte : ${displayUser.name} (${displayUser.email})`}
            aria-label={`Ouvrir le menu utilisateur (${displayUser.name})`}
            aria-haspopup="menu"
            aria-expanded={userMenuOpen}
            onClick={() => setUserMenuOpen((o) => !o)}
          >
            <span className="sidenav-user-avatar" aria-hidden="true">
              {displayUser.initials}
            </span>
            <span className="sidenav-user-info">
              <span className="sidenav-user-name">{displayUser.name}</span>
              <span className="sidenav-user-tier">{displayUser.tier}</span>
            </span>
          </button>
          <md-icon-button
            className="sidenav-settings"
            aria-label="Compte et paramètres"
            title="Compte et paramètres"
            onClick={onOpenAccount}
          >
            <md-icon>settings</md-icon>
          </md-icon-button>
        </div>

        {/* ── Menu utilisateur (dropdown, au-dessus du pied) ── */}
        {userMenuOpen && (
          <div
            className="sidenav-user-menu"
            ref={userMenuRef}
            role="menu"
            aria-label="Menu utilisateur"
          >
          <div className="sidenav-user-menu-head">
            <span className="sidenav-user-avatar" aria-hidden="true">
              {displayUser.initials}
            </span>
            <span className="sidenav-user-menu-copy">
              <span className="sidenav-user-menu-name">{displayUser.name}</span>
              <span className="sidenav-user-menu-tier">
                {displayUser.tier} · {displayUser.organization}
              </span>
            </span>
          </div>

          {USER_MENU_ITEMS.map((item) => (
            <button
              key={item.tab}
              type="button"
              role="menuitem"
              className="sidenav-user-menu-item"
              onClick={() => {
                setUserMenuOpen(false);
                onNavigateSettings(item.tab);
              }}
            >
              <md-icon>{item.icon}</md-icon>
              <span>{item.label}</span>
            </button>
          ))}

          <div className="sidenav-user-menu-divider" role="separator" />

          <button
            type="button"
            role="menuitem"
            className="sidenav-user-menu-item sidenav-user-menu-item--danger"
            onClick={() => {
              setUserMenuOpen(false);
              onSignOut();
            }}
          >
            <md-icon>logout</md-icon>
            <span>Se déconnecter</span>
          </button>
        </div>
        )}
      </footer>
    </aside>
  );
}
