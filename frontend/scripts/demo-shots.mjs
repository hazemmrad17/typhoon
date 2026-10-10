#!/usr/bin/env node
// =============================================================================
//   TYPHOON — CAPTURES D'ÉCRAN DES PARCOURS
//
//   Rejoue le parcours réel dans un vrai Chrome et écrit une PNG par écran dans
//   docs/screenshots/ : landing, connexion, tableau de bord, portefeuille,
//   surveillance, puis les QUATRE étapes du tunnel (adresse → analyse → jumeau →
//   rapport).
//
//   Pourquoi rejouer plutôt que retoucher : le tableau de bord, le portefeuille
//   et la page rapport lisent le CACHE LOCAL des diagnostics
//   (`typhoon.zone.cache`) — une capture « propre » sur un profil vierge ne
//   montrerait que des états vides. Le script diagnostique donc d'abord les
//   adresses de référence, PUIS capture les pages qui les agrègent : c'est le
//   même ordre que celui d'une démo.
//
//   Mise en route :
//     cd frontend
//     npm i -D playwright        # outil de capture, hors des dépendances de l'app
//     node scripts/demo-shots.mjs
//
//   Prérequis : un dev server Vite déjà lancé (npm run dev) et un backend
//   joignable. Par défaut le script vise http://127.0.0.1:5173. Pour capturer
//   contre un backend DISTANT (utile quand la machine de capture ne joint pas
//   Géorisques — l'API publique est alors inaccessible et le diagnostic met
//   ~200 s au lieu de quelques secondes), lancer le dev server ainsi :
//
//     VITE_API_BASE=https://<backend> npm run dev -- --host 127.0.0.1
//
//   Variables d'environnement :
//     SHOTS_BASE      URL de l'application          (défaut http://127.0.0.1:5173)
//     SHOTS_ADDRESSES adresses diagnostiquées d'abord, séparées par « | »
//     SHOTS_ONLY      n'exécuter que ces captures, séparées par « » (« , »)
//     SHOTS_OUT       dossier de sortie             (défaut ../docs/screenshots)
//     CHROME_PATH       exécutable Chrome/Chromium  (défaut : chemins usuels)
//     SHOTS_STATE       fichier d'état du navigateur (défaut : temp système)
//     PLAYWRIGHT_HOME   node_modules contenant playwright, si l'outil a été
//                       installé ailleurs que dans frontend/ (aucune dépendance
//                       de capture n'est imposée à l'application)
//
//   Le script ÉCHOUE (code 1) si un écran attendu ne s'est pas rendu : une
//   capture prise pendant un chargement, ou sur une page d'erreur, est
//   annoncée au lieu d'être commitée en silence.
// =============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** Playwright est l'outil de capture, pas une dépendance de l'application : il
 *  est résolu depuis frontend/node_modules, ou depuis `PLAYWRIGHT_HOME` quand il
 *  vit ailleurs (import CJS : `chromium` n'est pas un export nommé détectable).
 *  L'échec est explicite — jamais un écran non capturé en silence. */
async function loadChromium() {
  try {
    return (await import('playwright')).chromium;
  } catch (first) {
    const home = process.env.PLAYWRIGHT_HOME;
    if (!home) {
      throw new Error(
        `playwright introuvable (${first.message.split('\n')[0]}) — « npm i -D playwright » ou PLAYWRIGHT_HOME=<node_modules>`,
      );
    }
    return createRequire(path.join(home, '_resolve.cjs'))('playwright').chromium;
  }
}

const chromium = await loadChromium();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const BASE = (process.env.SHOTS_BASE || 'http://127.0.0.1:5173').replace(/\/$/, '');
const OUT = process.env.SHOTS_OUT || path.join(REPO, 'docs', 'screenshots');
const STATE = process.env.SHOTS_STATE || path.join(os.tmpdir(), 'typhoon-shots-state.json');
const MANIFEST = path.join(os.tmpdir(), 'typhoon-shots-manifest.json');
const VIEWPORT = { width: 1440, height: 900 };

/** Adresses de référence (README → « Démo ») : la TRI de référence, l'absence
 *  honnête (dans un TRI sans classe au point), et le contraste hors TRI. */
const SEED_ADDRESSES = (
  process.env.SHOTS_ADDRESSES ||
  /* Brou est en 28160 (le code 28300 des notes de démonstration désignait
     Saint-Prest : le géocodeur répond « adresse ambiguë » sur « Brou 28300 »,
     et l'API refuse alors de diagnostiquer — comportement attendu, cf. la
     capture « adresse ambiguë » plus bas). */
  'Quai de la Rapée 75012 Paris|10 Quai de la Charente 75019 Paris|Rue de la République 28160 Brou'
)
  .split('|')
  .map((s) => s.trim())
  .filter(Boolean);

const ONLY = process.env.SHOTS_ONLY
  ? new Set(process.env.SHOTS_ONLY.split(',').map((s) => s.trim()))
  : null;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const DONE_BUDGET_MS = 360_000; // borne de la demande de diagnostic côté app (5 min)

let page;
const manifest = [];
const failures = [];

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${stamp()}]`, ...a);
const settle = (ms) => page.waitForTimeout(ms);

/** Capture une PNG et consigne ce que la page AFFICHAIT (une capture dont le
 *  texte se limite à « Chargement… » est un échec, pas une capture). */
async function shot(name, note) {
  if (ONLY && !ONLY.has(name)) return;
  const file = path.join(OUT, `${name}.png`);
  const text = await pageText();
  await page.screenshot({ path: file });
  const twin = await page
    .evaluate(() => {
      const c = document.querySelector('canvas.twin-world-surface');
      if (!c) return null;
      return {
        focused: c.dataset.twinFocused ?? null,
        marker: c.dataset.twinMarker ?? null,
        w: c.width,
        h: c.height,
      };
    })
    .catch(() => null);
  manifest.push({ name, url: page.url(), note, chars: text.length, twin, text: text.slice(0, 900) });
  log(`shot ${name.padEnd(24)} <- ${page.url().replace(BASE, '')} (${text.length} car.)`);
}

/** Le texte visible, iframe comprise : la landing est servie dans une iframe
 *  (`StaticPage`), dont le contenu n'apparaît pas dans `body.innerText`. */
async function pageText() {
  const own = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  if (own.length > 40) return own;
  const inner = await page
    .evaluate(() => {
      const f = document.querySelector('iframe');
      try {
        return f?.contentDocument?.body?.innerText ?? '';
      } catch {
        return '';
      }
    })
    .catch(() => '');
  return `${own} ${String(inner).replace(/\s+/g, ' ').trim()}`.trim();
}

/** Ce que la page a réellement monté pour le monde du jumeau — sans debugger. */
function twinDiagnostics() {
  return page.evaluate(() => {
    const probe = document.createElement('canvas');
    const gl2 = !!probe.getContext('webgl2');
    const gl = gl2 || !!probe.getContext('webgl');
    const canvases = Array.from(document.querySelectorAll('canvas')).map(
      (c) => `${c.className || c.id || '(sans nom)'} ${c.width}x${c.height}`,
    );
    return { webgl: gl, webgl2: gl2, canvases, stepChip: document.querySelector('.step-chip')?.getAttribute('aria-label') };
  });
}

/** Un écran « vide » (état vide, page d'erreur) est signalé comme tel. */
/* ── Connexion ─────────────────────────────────────────────────────────────── */

async function ensureSignedIn() {
  if (await page.locator('.dash-hello-eyebrow, .portfolio-header, button.sim-indicator').count()) return;
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await settle(1500);
  const demo = page.getByRole('button', { name: /Entrer avec ce compte/i });
  if (await demo.count()) {
    await demo.first().click();
    await settle(3000);
    log('connecté avec le compte de démonstration');
  } else {
    log('AVERTISSEMENT : bouton de démonstration absent — session déjà ouverte ?');
  }
}

/* ── Le tunnel : une adresse → le diagnostic ───────────────────────────────── */

/** Le bouton d'étape suivante est DÉSACTIVÉ tant qu'aucun diagnostic n'existe
 *  (`stepLocked = step === 1 && !report`) : c'est le signal de fin, et il est
 *  positif — contrairement à la disparition d'un bandeau de chargement.
 *
 *  `.forward` n'est pas décoratif : dès l'étape 2, le bouton « retour » porte la
 *  même classe `sim-indicator` et vient EN PREMIER dans le DOM — un sélecteur
 *  sans `.forward` cliquait le retour (l'étape 3 sautait d'elle-même à 1). */
const NEXT_ENABLED = 'button.sim-indicator.forward:not([disabled])';

async function diagnose(address) {
  log(`diagnostic : ${address}`);
  await page.goto(`${BASE}/diagnostic?q=${encodeURIComponent(address)}`, {
    waitUntil: 'domcontentloaded',
  });
  await settle(2500);

  const enabled = await page.locator(NEXT_ENABLED).count();
  if (!enabled) {
    const field = page.locator('#addr-input-hero');
    await field.click();
    await field.fill('');
    await field.type(address, { delay: 25 });
    await settle(1200);
    await page.keyboard.press('Enter');
    await settle(1500);
    if (!(await page.locator('.hero-thinking, button.sim-indicator:not([disabled])').count())) {
      await page.locator('[aria-label="Diagnostiquer cette adresse"]').first().click({ force: true });
    }
  }

  await page
    .waitForSelector(NEXT_ENABLED, { timeout: DONE_BUDGET_MS })
    .catch(() => failures.push(`diagnostic ${address} : aucun résultat dans la borne`));

  const error = await page.locator('.hero-error').count();
  if (error) {
    const text = await page.locator('.hero-error').first().innerText().catch(() => '');
    failures.push(`diagnostic ${address} : erreur affichée — ${text.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  const place = await page.locator('.loc-chip').first().innerText().catch(() => '');
  log(`   résultat : ${place.replace(/\s+/g, ' ').trim().slice(0, 70) || "adresse non lue à l'écran"}`);
}

/** Fait avancer le tunnel d'une étape et attend que le chip d'étape bascule. */
async function nextStep(step) {
  const before = await page.locator('.step-chip').first().getAttribute('aria-label').catch(() => null);
  await page.locator(NEXT_ENABLED).first().click();
  try {
    await page.waitForSelector(`.step-chip[aria-label="Étape ${step} sur 4"]`, { timeout: 45_000 });
  } catch {
    const diag = await twinDiagnostics().catch((e) => ({ erreur: e.message }));
    failures.push(
      `étape ${step} : le chip d'étape est resté sur « ${before} » — ${JSON.stringify(diag)}`,
    );
    log(`ÉCHEC étape ${step} : chip resté sur « ${before} »`, JSON.stringify(diag));
  }
}

/* ── Le scénario de capture ────────────────────────────────────────────────── */

/** Les pages publiques sont capturées HORS session : /login redirige un visiteur
 *  déjà connecté vers l'application, et la capture montrerait le tableau de bord
 *  en s'intitulant « connexion ». */
async function capturePublic(browser) {
  const anon = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  page = await anon.newPage();
  wire(page);
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await settle(7000); // la landing est une page statique servie dans une iframe
  await shot('01-landing', 'Landing — point public d’entrée');

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await settle(2500);
  await shot('02-connexion', 'Connexion — compte de démonstration local, sans annuaire');
  await anon.close();
}

async function run(browser) {
  await capturePublic(browser);

  /* Session authentifiée : un SECOND contexte, créé après la fermeture du
     premier (une page ne survit pas au contexte qui l'a ouverte). Son état est
     persisté à la sortie : le cache local des diagnostics s'accumule d'une
     exécution à l'autre. */
  const session = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    ...(fs.existsSync(STATE) ? { storageState: STATE } : {}),
  });
  page = await session.newPage();
  wire(page);

  await ensureSignedIn();

  /* Le cache local alimente le tableau de bord et le portefeuille : on
     diagnostique d'abord les adresses de référence. */
  if (!ONLY || ONLY.has('_seed')) {
    for (const address of SEED_ADDRESSES) {
      await diagnose(address);
      await settle(1500);
    }
  }

  for (const [name, route, note] of [
    ['03-tableau-de-bord', '/dashboard', 'Tableau de bord — KPI, activité, qualité des faits'],
    ['04-portefeuille', '/portfolio', 'Portefeuille — le livre des actifs diagnostiqués'],
    ['05-surveillance', '/watchlist', 'Surveillance — adresses suivies et CatNat'],
  ]) {
    if (ONLY && !ONLY.has(name)) continue;
    await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
    await settle(3500);
    await shot(name, note);
  }

  /* ── Les quatre étapes du tunnel, sur l'adresse de référence ── */
  await diagnose(SEED_ADDRESSES[0]);
  await page.waitForSelector('.step-chip[aria-label="Étape 1 sur 4"]', { timeout: 20_000 }).catch(() => {});
  await settle(6000); // tuiles de carte + photo terrain
  await shot('06-etape1-diagnostic', 'Étape 1 — aléas au point et fiche BDNB');

  await nextStep(2);
  await settle(9000); // classes TRI + enveloppe d'eau
  await shot('07-etape2-scenarios', 'Étape 2 — classes TRI officielles et hauteur d\'eau');

  await nextStep(3);
  await page.waitForSelector('canvas.twin-world-surface', { timeout: 45_000 }).catch(() => {
    failures.push('étape 3 : le canvas du jumeau ne s\'est pas monté');
  });
  await settle(12_000); // construction des volumes + premier rendu WebGL
  await shot('08-etape3-jumeau', 'Étape 3 — le jumeau : volumes du bien et nappe');

  /* Étape 4 = la page /report : elle n'a PAS de chip d'étape (le tunnel s'arrête
     à l'étape 3 et la dernière étape est une route à part), donc la
     vérification porte sur l'URL, jamais sur un chip qui n'existe pas. */
  await page.locator(NEXT_ENABLED).first().click();
  await page.waitForURL(/\/report/, { timeout: 45_000 }).catch(() => {
    failures.push('étape 4 : la navigation vers /report n\'a pas eu lieu');
  });
  await settle(14_000); // prose en flux (SSE)
  await shot('09-rapport', 'Étape 4 — le rapport de risque, page autonome');

  await page.goto(`${BASE}/settings/account`, { waitUntil: 'domcontentloaded' });
  await settle(2500);
  await shot('10-parametres', 'Paramètres du compte');

  await captureAmbiguous();

  await session.storageState({ path: STATE });
}

/** L'API refuse une adresse ambiguë au lieu de choisir pour l'utilisateur
 *  (`detail.error = adresse_ambigue` + le libellé proposé). C'est un
 *  comportement, pas une panne : il mérite sa capture — en DERNIER, car il
 *  laisse le tunnel sur un état d'erreur. */
async function captureAmbiguous() {
  const address = process.env.SHOTS_AMBIGUOUS || 'Brou 28300';
  await page.goto(`${BASE}/diagnostic?q=${encodeURIComponent(address)}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('.hero-error', { timeout: 60_000 }).catch(() => {
    failures.push(`adresse ambiguë « ${address} » : aucun refus affiché`);
    return;
  });
  await settle(1500);
  await shot('11-adresse-ambigue', 'Refus d’une adresse ambiguë — l’API ne devine pas');
}

/* ── Traçage du navigateur ─────────────────────────────────────────────────── */

/** Une erreur de console ou une requête échouée explique la plupart des écrans
 *  restés vides : la consigner évite d'avoir à instrumenter le navigateur. */
function wire(p) {
  p.on('pageerror', (e) => log('pageerror:', String(e.message).slice(0, 160)));
  p.on('console', (m) => {
    if (m.type() === 'error') log('console.error:', m.text().slice(0, 160));
  });
  p.on('requestfailed', (r) => {
    const why = r.failure()?.errorText ?? '';
    if (!/ERR_ABORTED/.test(why)) log('requête échouée:', r.url().slice(0, 110), why.slice(0, 60));
  });
}

/* ── Entrée ────────────────────────────────────────────────────────────────── */

const exe = CHROME_CANDIDATES.find((p) => p && fs.existsSync(p));
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  ...(exe ? { executablePath: exe } : {}),
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
});
log(`navigateur : ${exe || 'chromium fourni par playwright'} · cible : ${BASE}`);

try {
  await run(browser);
} catch (error) {
  failures.push(`scénario interrompu : ${error.message.split('\n')[0]}`);
} finally {
  await browser.close();
}

fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
log(`manifeste : ${MANIFEST}`);

if (failures.length) {
  console.error(`\n${failures.length} échec(s) :`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`\n${manifest.length} capture(s) dans ${OUT}`);
