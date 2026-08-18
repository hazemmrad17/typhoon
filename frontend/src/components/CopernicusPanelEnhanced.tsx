// =============================================================================
//   TYPHOON — Projection climatique (Copernicus CDS) — version enrichie
//
//   Version améliorée du CopernicusPanel qui montre :
//   1. Tous les 8 périls (pas seulement canicule/precipitation)
//   2. Niveaux de confiance par péril
//   3. Métadonnées de source et résolution
//   4. Comparaison RCP 4.5 vs 8.5 enrichie
//   5. Tableau détaillé avec indicateurs de fiabilité
//
//   Données : /diagnostic/fast → digital_twin.trajectoire.perils
// =============================================================================

import { useState } from 'react';
import { SCENARIOS, type Trajectoire, type TrajectoirePeril, type TrajectoirePoint } from '../zone/config';

/* Dimensions du mini-chart SVG. */
const W = 320;
const H = 120;
const PAD = { top: 16, right: 12, bottom: 24, left: 35 };
const HORIZONS = [2026, 2050, 2100];

/* Couleurs par péril */
const PERIL_COLORS: Record<string, string> = {
  argile: '#8b5cf6',
  inondation: '#3b82f6',
  mouvement_terrain: '#f97316',
  sismicite: '#ef4444',
  radon: '#6b7280',
  canicule: '#dc2626',
  precipitation: '#0ea5e9',
  feu_foret: '#f59e0b',
};

function pathFor(values: (number | null)[], max: number): string {
  const x = (i: number) => PAD.left + (i / (HORIZONS.length - 1)) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - v / max) * (H - PAD.top - PAD.bottom);
  let d = '';
  values.forEach((v, i) => {
    if (v == null) return;
    d += `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
  });
  return d.trim();
}

/* Bornes de l'axe Y : [0, max] avec un peu d'air au-dessus. */
function yMax(values: (number | null)[]): number {
  const m = Math.max(10, ...values.filter((v): v is number => v != null));
  return Math.ceil((m * 1.15) / 10) * 10;
}

/* Indicateur de confiance */
function ConfidenceBadge({ confidence }: { confidence: string | null }) {
  if (!confidence) return <span className="cds-confidence cds-confidence-na">—</span>;
  const cls = confidence === 'elevee' ? 'cds-confidence-high' :
              confidence === 'moyenne' ? 'cds-confidence-medium' : 'cds-confidence-low';
  return <span className={`cds-confidence ${cls}`}>{confidence}</span>;
}

/* Indicateur de résolution */
function ResolutionBadge({ resolution }: { resolution: string | null }) {
  if (!resolution) return <span className="cds-resolution">—</span>;
  const label = resolution === 'per-building' ? 'Bâtiment' :
                resolution === 'commune-level' ? 'Commune' : 'Grille';
  const cls = resolution === 'per-building' ? 'cds-res-building' : 'cds-res-other';
  return <span className={`cds-resolution ${cls}`}>{label}</span>;
}

function PerilChart({
  code,
  label,
  color,
  serie,
  compare,
  confidence,
  resolution,
}: {
  code: string;
  label: string;
  color: string;
  serie: (number | null)[];
  compare: (number | null)[];
  confidence: string | null;
  resolution: string | null;
}) {
  const max = yMax([...serie, ...compare]);
  const line = pathFor(serie, max);
  const lineCmp = pathFor(compare, max);
  const x = (i: number) => PAD.left + (i / (HORIZONS.length - 1)) * (W - PAD.left - PAD.right);

  return (
    <div className="cds-chart-enhanced">
      <div className="cds-chart-header">
        <div className="cds-chart-title-row">
          <span className="cds-chart-dot" style={{ background: color }} />
          <span className="cds-chart-title">{label}</span>
        </div>
        <div className="cds-chart-meta">
          <ConfidenceBadge confidence={confidence} />
          <ResolutionBadge resolution={resolution} />
        </div>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Évolution de ${label} 2026-2100`}>
        {/* Grille horizontale + labels d'axe */}
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const yy = PAD.top + t * (H - PAD.top - PAD.bottom);
          const val = Math.round(max * (1 - t));
          return (
            <g key={t}>
              <line x1={PAD.left} x2={W - PAD.right} y1={yy} y2={yy} className="cds-chart-grid" />
              <text x={PAD.left - 4} y={yy + 3} className="cds-chart-y" textAnchor="end">
                {val}
              </text>
            </g>
          );
        })}
        {HORIZONS.map((h, i) => (
          <text key={h} x={x(i)} y={H - 6} className="cds-chart-x" textAnchor="middle">
            {h}
          </text>
        ))}
        {/* Comparaison RCP (autre scénario) en pointillés, puis série principale */}
        {lineCmp && <path d={lineCmp} className="cds-chart-line cds-chart-line-cmp" />}
        {line && <path d={line} className="cds-chart-line cds-chart-line-main" style={{ stroke: color }} />}
        {serie.map((v, i) =>
          v == null ? null : (
            <circle key={i} cx={x(i)} cy={PAD.top + (1 - v / max) * (H - PAD.top - PAD.bottom)} r="3.5"
                    className="cds-chart-dot" style={{ fill: color }} />
          )
        )}
      </svg>
    </div>
  );
}

export function CopernicusPanelEnhanced({ trajectoire }: { trajectoire: Trajectoire | null }) {
  const [scenario, setScenario] = useState<string>('rcp8_5');
  const [compareScenario, setCompareScenario] = useState<string>('rcp4_5');
  const [showAll, setShowAll] = useState(false);

  const perils = trajectoire?.perils ?? {};

  /* Tous les périls avec des données */
  const allPerils = Object.entries(perils).filter(([, p]) =>
    p.points.some((pt) => pt.type !== 'indisponible' && pt.valeur != null)
  );

  /* Périls avec projection modélisée À 2100 (la signature Copernicus CDS) */
  const modelled2100 = allPerils.filter(([, p]) =>
    p.points.some((pt) => pt.horizon === 2100 && pt.type === 'projete')
  );

  /* Périls projetés seulement à 2050 (Open-Meteo) */
  const projectedOnly2050 = allPerils.filter(([, p]) =>
    !p.points.some((pt) => pt.horizon === 2100 && pt.type === 'projete') &&
    p.points.some((pt) => pt.horizon === 2050 && pt.type === 'projete')
  );

  const perilsToShow = showAll ? allPerils : [...modelled2100, ...projectedOnly2050.slice(0, 2)];

  /* Scénarios réellement présents dans les données. */
  const availableScenarios = Array.from(
    new Set(
      Object.values(perils).flatMap((p) =>
        p.points
          .filter((pt) => pt.scenarios && Object.keys(pt.scenarios).length > 0)
          .flatMap((pt) => Object.keys(pt.scenarios ?? {}))
      )
    )
  );
  const scenarioOptions = SCENARIOS.filter((s) => availableScenarios.includes(s.key));

  function valueAt(p: TrajectoirePeril, horizon: number, sc: string): number | null {
    const pt = p.points.find((x) => x.horizon === horizon);
    if (!pt || pt.type === 'indisponible') return null;
    if (pt.scenarios && sc in pt.scenarios) return pt.scenarios[sc] ?? null;
    return pt.valeur;
  }

  function serieFor(p: TrajectoirePeril, sc: string): (number | null)[] {
    return HORIZONS.map((h) => valueAt(p, h, sc));
  }

  function getConfidence(p: TrajectoirePeril): string | null {
    const pt = p.points.find((x) => x.horizon === 2026);
    return pt?.confiance ?? null;
  }

  function getResolution(p: TrajectoirePeril): string | null {
    const pt = p.points.find((x) => x.horizon === 2026);
    return pt?.resolution ?? null;
  }

  function getSource(p: TrajectoirePeril): string | null {
    const pt = p.points.find((x) => x.horizon === 2026);
    return pt?.source ?? null;
  }

  return (
    <section className="cds-panel-enhanced" aria-label="Projection climatique Copernicus">
      <div className="cds-panel-head">
        <div className="cds-panel-title-row">
          <span className="cds-panel-title">Projection climatique</span>
          <span className="cds-chip" title="Indicatif — ne constitue pas un verdict de souscription.">
            Indicatif
          </span>
        </div>
        <p className="cds-panel-subtitle">
          Évolution modélisée de l'exposition aux périls climatiques — signal de tarification et de vigilance.
        </p>
      </div>

      {scenarioOptions.length > 1 && (
        <div className="cds-scenario-controls">
          <div className="horizon-toggle scenario-toggle" role="group" aria-label="Scénario climatique (RCP)">
            {scenarioOptions.map((s) => (
              <button
                key={s.key}
                type="button"
                className={`horizon-btn${scenario === s.key ? ' active' : ''}`}
                aria-pressed={scenario === s.key}
                title={s.hint}
                onClick={() => {
                  setScenario(s.key);
                  setCompareScenario(scenarioOptions.find((o) => o.key !== s.key)?.key ?? s.key);
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {allPerils.length === 0 ? (
        <p className="cds-panel-empty">
          {trajectoire
            ? 'Aucune donnée de projection disponible pour les périls.'
            : 'Projection indisponible — relancez le diagnostic.'}
        </p>
      ) : (
        <>
          <div className="cds-charts-enhanced">
            {perilsToShow.map(([code, p]) => (
              <PerilChart
                key={code}
                code={code}
                label={p.label}
                color={PERIL_COLORS[code] || '#888'}
                serie={serieFor(p, scenario)}
                compare={serieFor(p, compareScenario)}
                confidence={getConfidence(p)}
                resolution={getResolution(p)}
              />
            ))}
          </div>

          {allPerils.length > perilsToShow.length && (
            <button
              type="button"
              className="cds-show-all-btn"
              onClick={() => setShowAll(!showAll)}
            >
              {showAll ? 'Voir moins' : `Voir tous les ${allPerils.length} périls`}
            </button>
          )}

          {/* Tableau détaillé avec confiance et résolution */}
          <div className="trajectoire-table cds-table-enhanced">
            <div className="traj-row traj-head">
              <span>Péril</span>
              <span>2026</span>
              <span>2050</span>
              <span>2100</span>
              <span>Confiance</span>
              <span>Résolution</span>
              <span>Source</span>
            </div>
            {allPerils.map(([code, p]) => (
              <div className="traj-row" key={code}>
                <span className="traj-name">
                  <span className="cds-table-dot" style={{ background: PERIL_COLORS[code] || '#888' }} />
                  {p.label}
                </span>
                {HORIZONS.map((h) => {
                  const v = valueAt(p, h, scenario);
                  return (
                    <span key={h} className={`cds-cell${v == null ? ' cds-cell-na' : ''}`}>
                      {v ?? '—'}
                    </span>
                  );
                })}
                <span className="cds-cell">
                  <ConfidenceBadge confidence={getConfidence(p)} />
                </span>
                <span className="cds-cell">
                  <ResolutionBadge resolution={getResolution(p)} />
                </span>
                <span className="cds-cell cds-source">
                  {getSource(p) || '—'}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="cds-panel-meta">
        <span>
          Source : Copernicus Climate Data Store (ECMWF) + Open-Meteo · indicateurs modélisés, valeur indicative —
          comparer avec la valeur observée (Géorisques) de l'étape précédente.
        </span>
      </div>
    </section>
  );
}
