import { StaticPage } from './StaticPage';

// Cache-buster: forces the browser to revalidate /landing.html instead of
// serving a stale cached copy (the landing page is a static file in public/).
const LANDING_SRC = '/landing.html?v=20260816-hero-space5';


export function Home() {
  return <StaticPage src={LANDING_SRC} title="Typhon" />;
}
