// =============================================================================
//   TYPHOON — /zone : panneau latéral DROIT — ALERTES (style Behance)
//   Vigilance crues réelle (Vigicrues) — TOUJOURS live :
//     · par défaut (aucune adresse) : résumé national de la France entière +
//       les tronçons orange/rouge actifs ;
//     · une fois une adresse diagnostiquée : les tronçons actifs triés par
//       proximité de l'adresse.
//   Source : InfoVigiCru.geojson (proxy dev /vigicrues). La vigilance météo
//   Météo-France n'est pas accessible (403) — on se limite aux crues.
// =============================================================================

import { useEffect, useMemo, useState } from 'react';
import type { RisqueReport } from '../zone/config';

const LEVELS: Record<number, { label: string; color: string }> = {
  1: { label: 'VERT', color: '#2fbf71' },
  2: { label: 'JAUNE', color: '#f0c33c' },
  3: { label: 'ORANGE', color: '#ff9f0a' },
  4: { label: 'ROUGE', color: '#ff3b30' },
};

type Feature = {
  name: string;
  level: number;
  coords?: number[][][];
};

/* Distance (km) entre un point et un tronçon (sommet le plus proche). */
function distKm(lat: number, lon: number, coords: number[][][]): number {
  let best = Infinity;
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  for (const line of coords) {
    for (const [x, y] of line) {
      const dLat = toRad(y - lat);
      const dLon = toRad(x - lon);
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat)) * Math.cos(toRad(y)) * Math.sin(dLon / 2) ** 2;
      const d = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      if (d < best) best = d;
    }
  }
  return best;
}

/* Point de recentrage d'un tronçon : milieu du premier segment suffisamment
   long (sinon premier sommet). Renvoie [lon, lat]. */
function featurePoint(coords: number[][][]): [number, number] | null {
  for (const line of coords || []) {
    if (line.length >= 2) {
      const mid = Math.floor(line.length / 2);
      const [x, y] = line[mid];
      if (typeof x === 'number' && typeof y === 'number') return [x, y];
    }
    const [x, y] = line[0] || [];
    if (typeof x === 'number' && typeof y === 'number') return [x, y];
  }
  return null;
}

export function RightAlertsPanel({
  report,
  onFocusAlert,
  onAlertsChange,
}: {
  report: RisqueReport | null;
  /** Recentrer la carte sur un tronçon (alerte) — mis en place par Zone.tsx
   *  pour voler vers la zone et poser un indicateur animé sur la carte. */
  onFocusAlert?: (a: { lat: number; lon: number; name: string; level: number }) => void;
  /** Liste des alertes affichées (avec leur point), remontée à Zone.tsx pour
   *  poser des indicateurs colorés sur la carte. */
  onAlertsChange?: (a: { lat: number; lon: number; name: string; level: number }[]) => void;
}) {
  const [all, setAll] = useState<Feature[] | null>(null);
  const [loading, setLoading] = useState(false);
  /* Distinct de `all === []` : un service muet n'est pas « aucune alerte ». */
  const [error, setError] = useState(false);

  /* Charge la vigilance de TOUTE la France une seule fois (mount). */
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch('/vigicrues/services/InfoVigiCru.geojson')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((fc: {
        features?: {
          properties?: { NivInfViCr?: number; lbentcru?: string };
          geometry?: { type?: string; coordinates?: number[][][] };
        }[];
      }) => {
        if (!alive) return;
        const out: Feature[] = [];
        for (const f of fc.features || []) {
          const level = f.properties?.NivInfViCr ?? 0;
          const name = f.properties?.lbentcru;
          const coords = f.geometry?.coordinates;
          if (!name || level < 1) continue;
          out.push({ name, level, coords });
        }
        setAll(out);
      })
      .catch(() => {
        if (alive) {
          setAll([]);
          setError(true);
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  /* Tronçons affichés : TOUS les niveaux, le plus élevé (ou le plus proche
     de l'adresse) d'abord, plafonnés pour rester lisibles. */
  const display = useMemo(() => {
    if (!all) return [];
    const list = [...all];
    if (report) {
      list.sort((a, b) => {
        const da = a.coords ? distKm(report.lat, report.lon, a.coords) : Infinity;
        const db = b.coords ? distKm(report.lat, report.lon, b.coords) : Infinity;
        return da - db;
      });
    } else {
      list.sort((a, b) => b.level - a.level);
    }
    return list.slice(0, 10);
  }, [all, report]);

  /* Répartition nationale par niveau. */
  const counts = useMemo(() => {
    const c: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const f of all || []) c[f.level] = (c[f.level] || 0) + 1;
    return c;
  }, [all]);

  const activeCount = (counts[3] || 0) + (counts[4] || 0);
  const maxLevel = display.length ? display[0].level : 0;

  /* Remonte les alertes affichées (avec leur point de recentrage) à Zone.tsx
     pour que la carte pose un indicateur coloré par tronçon. */
  useEffect(() => {
    const pts = display
      .map((s) => {
        const p = s.coords ? featurePoint(s.coords) : null;
        return p ? { lat: p[1], lon: p[0], name: s.name, level: s.level } : null;
      })
      .filter((x): x is { lat: number; lon: number; name: string; level: number } => !!x);
    onAlertsChange?.(pts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [display]);

  return (
    <aside className="right-panels" aria-label="Alertes en cours">
      <section className="side-panel right-panel" aria-label="Alertes">
        <header className="side-panel-head">
          <h2>Alertes</h2>
          {all && (
            <span className="alert-count" aria-hidden="true">
              {error
                ? 'Indisponible'
                : activeCount > 0
                  ? `${activeCount} active`
                  : 'Aucune alerte'}
            </span>
          )}
        </header>

        {loading ? (
          <div className="alert-list">
            <div className="side-empty">
              <md-icon aria-hidden="true">hourglass_empty</md-icon>
              <span>Chargement de la vigilance crues…</span>
            </div>
          </div>
        ) : error ? (
          <div className="alert-list">
            <div className="side-empty">
              <md-icon aria-hidden="true">cloud_off</md-icon>
              <span>Vigilance crues indisponible — le service Vigicrues ne répond pas.</span>
            </div>
          </div>
        ) : !all || all.length === 0 ? (
          <div className="alert-list">
            <div className="side-empty">
              <md-icon aria-hidden="true">notifications_off</md-icon>
              <span>Aucune vigilance crues en cours</span>
            </div>
          </div>
        ) : (
          <>
            {/* Résumé : niveau max + répartition nationale */}
            <div className="alert-summary" style={{ borderColor: LEVELS[maxLevel]?.color }}>
              <span className="alert-summary-label">
                {report ? 'Vigilance · à proximité' : 'Vigilance crues · France'}
              </span>
              <span className="alert-summary-level" style={{ color: LEVELS[maxLevel]?.color }}>
                {maxLevel > 0 ? LEVELS[maxLevel]?.label : 'AUCUNE'}
              </span>
            </div>
            <div className="alert-summary-strip">
              {[4, 3, 2, 1].map((lv) => (
                <span key={lv} className="alert-strip-item">
                  <i style={{ background: LEVELS[lv].color }} />
                  {LEVELS[lv].label} · {counts[lv] || 0}
                </span>
              ))}
            </div>
            <div className="alert-list">
              {display.map((s, i) => {
                const d = report && s.coords ? distKm(report.lat, report.lon, s.coords) : null;
                const pt = s.coords ? featurePoint(s.coords) : null;
                const move = () => {
                  if (!pt) return;
                  onFocusAlert?.({
                    lat: pt[1],
                    lon: pt[0],
                    name: s.name,
                    level: s.level,
                  });
                };
                return (
                  <article
                    className={`alert-card${s.level >= 3 ? ' alert-active' : ''}`}
                    key={`${s.name}-${i}`}
                  >
                    <div className="alert-top">
                      <span className="alert-kind">{s.name}</span>
                      <span
                        className="alert-badge on"
                        style={{ background: LEVELS[s.level].color, color: '#fff' }}
                      >
                        {LEVELS[s.level].label}
                      </span>
                    </div>
                    <span className="alert-place">
                      {d != null
                        ? `à ${d < 1 ? '<1' : Math.round(d)} km`
                        : 'En vigilance'}
                    </span>
                    {pt && onFocusAlert && (
                      <button
                        type="button"
                        className="alert-move"
                        aria-label={`Aller à ${s.name}`}
                        title="Voir sur la carte"
                        onClick={move}
                      >
                        <md-icon aria-hidden="true">near_me</md-icon>
                        <span>Voir</span>
                      </button>
                    )}
                  </article>
                );
              })}
              {display.length === 0 && (
                <div className="side-empty">
                  <md-icon aria-hidden="true">notifications_off</md-icon>
                  <span>Aucune vigilance crues disponible</span>
                </div>
              )}
            </div>
          </>
        )}
      </section>
    </aside>
  );
}