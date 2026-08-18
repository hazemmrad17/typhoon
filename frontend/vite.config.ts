import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Jeton Mapbox du miroir (landing EVpin) : les chunks du miroir embarquaient
 * un jeton Mapbox en dur, ce qui déclenche la protection push de GitHub
 * (secret-scanning). Le jeton est remplacé par un marqueur dans le repo et
 * injecté au moment du serve (dev) / du build (prod) depuis VITE_MAPBOX_TOKEN
 * (racine .env — envDir: '..'). Aucun jeton n'est jamais committé.
 */
const MAPBOX_MARKER = '__TYPHOON_MAPBOX_TOKEN__';

function mapboxTokenPlugin(): Plugin {
  let token = '';
  const rewrite = (buf: Buffer): Buffer | null => {
    if (!buf.includes(Buffer.from(MAPBOX_MARKER))) return null;
    return Buffer.from(buf.toString('utf-8').split(MAPBOX_MARKER).join(token));
  };
  const rewriteDir = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.js')) continue;
      const p = path.join(dir, name);
      const out = rewrite(fs.readFileSync(p));
      if (out) fs.writeFileSync(p, out);
    }
  };
  return {
    name: 'typhoon-mapbox-token',
    configResolved(cfg) {
      const env = loadEnv(cfg.mode, path.resolve(ROOT, '..'), '');
      token = env.VITE_MAPBOX_TOKEN || '';
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url || '/', 'http://localhost');
        const p = url.pathname;
        if (p !== '/landing.html' && !p.startsWith('/_next/static/chunks/')) return next();
        const rel = p.replace(/^\/+/, '');
        const file = path.resolve(PUBLIC_DIR, rel);
        if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return next();
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return next();
        const out = rewrite(fs.readFileSync(file));
        if (!out) return next();
        res.setHeader('Content-Type', BIM_MIME[path.extname(file)] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(out);
      });
    },
    closeBundle() {
      // Production : injecter le jeton dans les copies du dist
      const outDir = path.resolve(ROOT, 'dist');
      rewriteDir(path.join(outDir, '_next', 'static', 'chunks'));
      const lp = path.join(outDir, 'landing.html');
      if (fs.existsSync(lp)) {
        const out = rewrite(fs.readFileSync(lp));
        if (out) fs.writeFileSync(lp, out);
      }
    },
  };
}

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BIM_VIEWER_DIST = path.join(ROOT, 'bim-viewer', 'dist');
const PUBLIC_DIR = path.join(ROOT, 'public');

/**
 * Sert les images des pages miroir (landing EVpin) : le composant next/image
 * du miroir réécrit les <img> vers /_next/image?url=...&w=...&q=... — une
 * route API Next absente de Vite. Ce middleware décode le paramètre `url`
 * (chemin local, ex. /partners/bdnb.png ou /cdn/...) et sert le fichier
 * depuis public/ avec le bon type MIME (comme le faisait serve.mjs).
 */
function nextImagePlugin(): Plugin {
  return {
    name: 'typhoon-next-image-static',
    configureServer(server) {
      server.middlewares.use('/_next/image', (req, res, _next) => {
        const url = new URL(req.url || '/', 'http://localhost');
        const target = url.searchParams.get('url');
        if (!target) {
          res.statusCode = 400;
          res.end('Bad Request');
          return;
        }
        let rel: string;
        try {
          rel = decodeURIComponent(target.replace(/^\/+/, ''));
        } catch {
          res.statusCode = 400;
          res.end('Bad Request');
          return;
        }
        // Sécurité : le chemin résolu doit rester DANS public/
        // Ordre de résolution (règle du miroir) : d'abord le chemin tel quel,
        // puis sous www/ (images de www.evpin.com) puis sous cdn/ (assets.evpin.com).
        const candidates = [rel, `www/${rel}`, `cdn/${rel}`];
        let resolved: string | null = null;
        for (const cand of candidates) {
          const p = path.resolve(PUBLIC_DIR, cand);
          if ((p === PUBLIC_DIR || p.startsWith(PUBLIC_DIR + path.sep)) && fs.existsSync(p) && fs.statSync(p).isFile()) {
            resolved = p;
            break;
          }
        }
        if (!resolved) {
          res.statusCode = 404;
          res.end('Not Found');
          return;
        }
        res.setHeader('Content-Type', BIM_MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        fs.createReadStream(resolved).pipe(res);
      });
    },
  };
}


const BIM_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.wasm': 'application/wasm',
  '.gltf': 'model/gltf+json',
  '.glb': 'model/gltf-binary',
  '.bin': 'application/octet-stream',
};

/**
 * Sert le build statique de frontend/bim-viewer/dist sous /bim-viewer/.
 *
 * En dev : middleware connect sur le dev server Vite (avec fallback SPA vers
 * index.html — le viewer est un routeur Vue en mode history).
 * En build : copie dist/bim-viewer dans l'outDir de Vite pour la prod.
 */
function bimViewerPlugin(): Plugin {
  return {
    name: 'typhoon-bim-viewer-static',
    configureServer(server) {
      server.middlewares.use('/bim-viewer', (req, res, next) => {
        if (!fs.existsSync(BIM_VIEWER_DIST)) {
          console.warn('[bim-viewer] dist introuvable — lancer: cd frontend/bim-viewer && npm run build');
          next();
          return;
        }
        const url = new URL(req.url || '/', 'http://localhost');
        let rel: string;
        try {
          rel = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
        } catch {
          res.statusCode = 400;
          res.end('Bad Request');
          return;
        }
        if (!rel) rel = 'index.html';
        // Sécurité : le chemin résolu doit rester DANS dist (un client non
        // normalisant peut envoyer des segments '..' — /bim-viewer/../../vite.config.ts).
        const resolved = path.resolve(BIM_VIEWER_DIST, rel);
        if (resolved !== BIM_VIEWER_DIST && !resolved.startsWith(BIM_VIEWER_DIST + path.sep)) {
          res.statusCode = 404;
          res.end('Not Found');
          return;
        }
        let file = resolved;
        const ext = path.extname(rel).toLowerCase();
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
          if (ext) {
            // Asset manquant : 404 propre (surtout pas de fallback HTML, qui
            // ferait planter les loaders JSON/wasm du viewer en 'Unexpected token <')
            res.statusCode = 404;
            res.end('Not Found');
            return;
          }
          // Fallback SPA uniquement pour les routes (routes history du
          // viewer : /projects/:projectId, /projects, /)
          file = path.join(BIM_VIEWER_DIST, 'index.html');
        }
        res.setHeader('Content-Type', BIM_MIME[path.extname(file)] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-cache');
        fs.createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      // Production : embarquer le viewer dans le dist Vite
      if (!fs.existsSync(BIM_VIEWER_DIST)) return;
      const outDir = path.resolve(ROOT, 'dist');
      fs.cpSync(BIM_VIEWER_DIST, path.join(outDir, 'bim-viewer'), { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [react(), bimViewerPlugin(), nextImagePlugin(), mapboxTokenPlugin()],
  // Un seul .env à la racine du dépôt pour le front ET le back : Vite charge
  // les variables (préfixe VITE_*) depuis ../.env (racine du projet).
  envDir: '..',
  server: {
    port: 5173,
  },
  build: {
    rollupOptions: {
      output: {
        // Chunk initial < 500 kB : les gros vendors stables (react-dom,
        // material-web, supabase) sont isolés dans des chunks dédiés —
        // cache navigateur pérenne (ils changent rarement) et la landing
        // n'a plus à télécharger les bibliothèques de carte (déjà
        // lazy-loadées via React.lazy dans App.tsx). Les libs non listées
        // gardent le comportement par défaut de Rollup (undefined).
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('@material/web')) return 'material-web';
          if (id.includes('@supabase')) return 'supabase';
          if (id.includes('react') || id.includes('scheduler')) return 'vendor-react';
          if (id.includes('mapbox-gl')) return 'mapbox';
          if (id.includes('maplibre-gl')) return 'maplibre';
          if (id.includes('/ol/')) return 'openlayers';
          if (
            id.includes('jspdf') ||
            id.includes('html2canvas') ||
            id.includes('dompurify') ||
            id.includes('canvg') ||
            id.includes('html2canvas-pro')
          ) {
            return 'pdf-vendor';
          }
          return undefined;
        },
      },
    },
  },
});
