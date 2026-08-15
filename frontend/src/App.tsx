import { Navigate, Route, Routes } from 'react-router-dom';
import { Home } from './routes/Home';
import { Zone } from './routes/Zone';
import { Faq } from './routes/Faq';
import { Contact } from './routes/Contact';
import { AccountSettings } from './routes/AccountSettings';
import { Portfolio } from './routes/Portfolio';
import { WatchlistPage } from './routes/WatchlistPage';

/**
 * Application Typhoon — toutes les pages sont autonomes (plein écran) :
 *   /                  → landing page
 *   /zone              → diagnostic géo-risque (stepper + carte)
 *   /faq, /contact     → pages typhoon
 *   /account, /settings → page « Paramètres du compte » (même chrome que /zone)
 *   /portfolio          → vue « livre » de l'assureur (Ticket 4)
 *   /watchlist          → communes/adresses suivies (Ticket 5)
 */
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/zone/*" element={<Zone />} />
      <Route path="/faq" element={<Faq />} />
      <Route path="/contact" element={<Contact />} />
      <Route path="/account" element={<AccountSettings />} />
      <Route path="/settings" element={<AccountSettings />} />
      <Route path="/settings/*" element={<AccountSettings />} />
      <Route path="/portfolio" element={<Portfolio />} />
      <Route path="/watchlist" element={<WatchlistPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}