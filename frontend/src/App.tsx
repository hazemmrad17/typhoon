import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { Home } from './routes/Home';
import { StaticPage } from './routes/StaticPage';
import { Zone } from './routes/Zone';
import { Faq } from './routes/Faq';
import { Contact } from './routes/Contact';
import { AccountSettings } from './routes/AccountSettings';
import { Portfolio } from './routes/Portfolio';
import { WatchlistPage } from './routes/WatchlistPage';
import { Dashboard } from './routes/Dashboard';
import { Login } from './routes/Login';
import { useAuth } from './typhoon/auth';

/**
 * Garde d'authentification : redirige vers /login (en mémorisant la page
 * d'origine) tant qu'aucun utilisateur n'est connecté. Le mode démo
 * (Supabase non configuré) laisse passer — MOCK_USER est actif.
 */
function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading, demo } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="auth-gate-loading" role="status">
        <md-circular-progress indeterminate />
        <span>Chargement…</span>
      </div>
    );
  }

  if (!demo && !user) {
    return <Navigate to="/login" state={{ from: location.pathname + location.search }} replace />;
  }

  return <>{children}</>;
}

/**
 * Application Typhon — toutes les pages sont autonomes (plein écran) :
 *   /                  → landing page
 *   /login             → authentification Supabase
 *   /zone              → diagnostic géo-risque (stepper + carte)
 *   /faq, /contact     → pages typhoon
 *   /account, /settings → page « Paramètres du compte » (même chrome que /zone)
 *   /dashboard         → vue d'ensemble (assureur)
 *   /portfolio         → vue « livre » de l'assureur (Ticket 4)
 *   /watchlist         → communes/adresses suivies (Ticket 5)
 *
 * Les pages applicatives (zone, dashboard, portfolio, watchlist, compte)
 * sont protégées par RequireAuth ; landing, faq, contact et login restent
 * publiques.
 */
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<Login />} />
      <Route path="/faq" element={<Faq />} />
      <Route path="/contact" element={<Contact />} />
      <Route path="/pricing" element={<StaticPage src="/pricing/index.html" title="Tarifs - Typhon" />} />
      <Route path="/changelog" element={<StaticPage src="/changelog/index.html" title="Nouveautés - Typhon" />} />
      <Route path="/tracker/charging-infrastructure" element={<StaticPage src="/tracker/charging-infrastructure/index.html" title="Tracker - Typhon" />} />
      <Route path="/product/design" element={<StaticPage src="/product/design/index.html" title="Design - Typhon" />} />
      <Route path="/product/evaluate" element={<StaticPage src="/product/evaluate/index.html" title="Évaluation - Typhon" />} />
      <Route path="/privacy" element={<StaticPage src="/privacy/index.html" title="Confidentialité - Typhon" />} />
      <Route path="/terms" element={<StaticPage src="/terms/index.html" title="Conditions - Typhon" />} />
      <Route
        path="/zone/*"
        element={
          <RequireAuth>
            <Zone />
          </RequireAuth>
        }
      />
      <Route
        path="/account"
        element={
          <RequireAuth>
            <AccountSettings />
          </RequireAuth>
        }
      />
      <Route
        path="/settings"
        element={
          <RequireAuth>
            <AccountSettings />
          </RequireAuth>
        }
      />
      <Route
        path="/settings/*"
        element={
          <RequireAuth>
            <AccountSettings />
          </RequireAuth>
        }
      />
      <Route
        path="/dashboard"
        element={
          <RequireAuth>
            <Dashboard />
          </RequireAuth>
        }
      />
      <Route
        path="/portfolio"
        element={
          <RequireAuth>
            <Portfolio />
          </RequireAuth>
        }
      />
      <Route
        path="/watchlist"
        element={
          <RequireAuth>
            <WatchlistPage />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}