// =============================================================================
//   TYPHOON — Projection climatique (Copernicus CDS) — panneau unique
//
//   Panneau « Projection climatique » de la vue Assurance : évolution
//   modélisée de l'exposition climatique en unités réelles (jours/an, °C, m/s)
//   sous les scénarios RCP du GIEC, horizons 2026 (observé) → 2050 → 2100
//   (projetés).
//
//   4 onglets (md-tabs Material 3) :
//     · Évolution       — graphique SVG par péril (2026→2100), comparaison
//                          entre les deux RCP (trait plein = scénario actif,
//                          pointillés = scénario de comparaison)
//     · Périodes retour — valeur F et variation % par horizon
//     · Qualité         — niveau de confiance & résolution spatiale des données
//     · Tableau         — vue dense de tous les indicateurs (valeurs, badges)
//
//   Le CopernicusStatusBanner (état du téléchargement CDS) s'affiche tant que
//   le point 2100 n'est pas disponible.
//
//   Données : GET /diagnostic/adresse → copernicus.trajectoire.perils (points
//   par horizon, valeurs en unités réelles, avec comparaison par scénario).
// =============================================================================

import { useState, useMemo } from 'react';
import { SCENARIOS, type Trajectoire, type TrajectoirePeril } from '../zone/config';
import { CopernicusStatusBanner } from './CopernicusStatusBanner';

/* Horizons de projection affichés (2026 observé / 2050 / 2100 projetés). */
const HORIZONS = [2026, 2050, 2100] as const;

/* Catégories d'indicateurs — couleurs = rôles Material 3 (tokens du thème
   .zone-app), donc adaptatives clair/sombre. */
const CATEGORIES = {
  temperature:   { label: 'Température',    icon: 'thermostat', color: 'var(--md-sys-color-error)' },
  precipitation: { label: 'Précipitations', icon: 'water_drop', color: 'var(--md-sys-color-primary)' },
  drought:       { label: 'Sécheresse',     icon: 'water',      color: 'var(--md-sys-color-tertiary)' },
  wind:          { label: 'Vent',           icon: 'air',        color: 'var(--md-sys-color-secondary)' },
} as const;
type CategoryKey = keyof typeof CATEGORIES;

/* Onglets du panneau — pilotent un md-tabs Material 3. */
const TABS = [
  { id: 'evolution', label: 'Évolution' },
  { id: 'retour', label: 'Périodes retour' },
  { id: 'qualite', label: 'Qualité' },
  { id: 'tableau', label: 'Tableau' },
] as const;
type TabId = (typeof TABS)[number]['id'];

/* Dimensions du mini-chart SVG. */
const CHART_W = 300;
const CHART_H = 128;
const PAD = { top: 16, right: 12, bottom: 24, left: 38 };

/* ── Helpers ── */

function valueAt(p: TrajectoirePeril, horizon: number, sc: string): number | null {
  const pt = p.points.find((x) => x.horizon === horizon);
  if (!pt || pt.type === 'indisponible') return null;
  if (pt.scenarios && sc in pt.scenarios) return pt.scenarios[sc] ?? null;
  return pt.valeur;
}

function yMax(values: (number | null)[]): number {
  const m = Math.max(10, ...values.filter((v): v is number => v != null));
  return Math.ceil((m * 1.15) / 10) * 10;
}

function pathFor(values: (number | null)[], max: number): string {
  const x = (i: number) => PAD.left + (i / (HORIZONS.length - 1)) * (CHART_W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - v / max) * (CHART_H - PAD.top - PAD.bottom);
  let d = '';
  values.forEach((v, i) => {
    if (v == null) return;
    d += `${d ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
  });
  return d.trim();
}

function categoryFor(code: string): CategoryKey {
  if (code.includes('precip') || code.includes('wet')) return 'precipitation';
  if (code.includes('dry') || code.includes('secheresse')) return 'drought';
  if (code.includes('wind') || code.includes('vent')) return 'wind';
  return 'temperature';
}

function uniteOf(p: TrajectoirePeril): string {
  return p.points.find((pt) => pt.unite)?.unite ?? '';
}

function scenarioLabel(sc: string): string {
  return SCENARIOS.find((s) => s.key === sc)?.label ?? sc;
}

function confLabel(v: string): string {
  return v === 'elevee' ? 'Élevée' : v === 'moyenne' ? 'Moyenne' : 'Faible';
}

function confCls(v: string): string {
  return v === 'elevee' ? 'cop-conf-high' : v === 'moyenne' ? 'cop-conf-medium' : 'cop-conf-low';
}

function resLabel(v: string): string {
  return v === 'per-building' ? 'Bâtiment' : v === 'commune-level' ? 'Commune' : 'Grille';
}

function resCls(v: string): string {
  return v === 'per-building' ? 'cop-res-building' : 'cop-res-other';
}

function countBy<T extends string>(values: (T | null)[]): Record<string, number> {
  return values.reduce<Record<string, number>>((acc, v) => {
    if (v != null) acc[v] = (acc[v] || 0) + 1;
    return acc;
  }, {});
}

/* ── Onglet Évolution ── */

function PerilChart({
  peril,
  scenario,
  compareScenario,
  color,
}: {
  peril: TrajectoirePeril;
  scenario: string;
  compareScenario: string;
  color: string;
}) {
  const serie = HORIZONS.map((h) => valueAt(peril, h, scenario));
  const compare = HORIZONS.map((h) => valueAt(peril, h, compareScenario));
  const max = yMax([...serie, ...compare]);
  const line = pathFor(serie, max);
  const lineCmp = pathFor(compare, max);
  const x = (i: number) => PAD.left + (i / (HORIZONS.length - 1)) * (CHART_W - PAD.left - PAD.right);
  const unit = uniteOf(peril);

  return (
    <div className="cop-chart">
      <div className="cop-chart-head">
        <span className="cop-chart-name">{peril.label}</span>
        {unit && <span className="cop-chart-unit">{unit}</span>}
      </div>
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} role="img" aria-label={`Évolution de ${peril.label} 2026-2100`}>
        {/* Grille + labels d'axe */}
        {[0, 0.5, 1].map((t) => {
          const yy = PAD.top + t * (CHART_H - PAD.top - PAD.bottom);
          const val = Math.round(max * (1 - t));
          return (
            <g key={t}>
              <line x1={PAD.left} x2={CHART_W - PAD.right} y1={yy} y2={yy} className="cop-chart-grid" />
              <text x={PAD.left - 5} y={yy + 3} className="cop-chart-y" textAnchor="end">{val}</text>
            </g>
          );
        })}
        {HORIZONS.map((h, i) => (
          <text key={h} x={x(i)} y={CHART_H - 6} className="cop-chart-x" textAnchor="middle">{h}</text>
        ))}
        {/* Comparaison RCP en pointillés, puis série active */}
        {lineCmp && <path d={lineCmp} className="cop-chart-line cop-chart-line-cmp" />}
        {line && <path d={line} className="cop-chart-line cop-chart-line-main" style={{ stroke: color }} />}
        {serie.map((v, i) =>
          v == null ? null : (
            <circle key={i} cx={x(i)} cy={PAD.top + (1 - v / max) * (CHART_H - PAD.top - PAD.bottom)} r="3.4"
                    className="cop-chart-dot" style={{ fill: color }} />
          )
        )}
      </svg>
    </div>
  );
}

function CategoryCard({
  category,
  perils,
  scenario,
  compareScenario,
}: {
  category: (typeof CATEGORIES)[CategoryKey];
  perils: [string, TrajectoirePeril][];
  scenario: string;
  compareScenario: string;
}) {
  const [open, setOpen] = useState(true);

  return (
    <section className="cop-category">
      <button
        type="button"
        className="cop-category-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <md-icon style={{ color: category.color }}>{category.icon}</md-icon>
        <span className="cop-category-label">{category.label}</span>
        <span className="cop-category-count">{perils.length}</span>
        <md-icon>{open ? 'expand_less' : 'expand_more'}</md-icon>
      </button>
      {open && (
        <div className="cop-category-body">
          {perils.map(([code, p]) => (
            <PerilChart
              key={code}
              peril={p}
              scenario={scenario}
              compareScenario={compareScenario}
              color={category.color}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function EvolutionTab({
  perils,
  scenario,
  compareScenario,
}: {
  perils: Record<string, TrajectoirePeril>;
  scenario: string;
  compareScenario: string;
}) {
  const grouped = useMemo(() => {
    const out: Record<CategoryKey, [string, TrajectoirePeril][]> = {
      temperature: [], precipitation: [], drought: [], wind: [],
    };
    for (const [code, p] of Object.entries(perils)) {
      if (HORIZONS.some((h) => valueAt(p, h, scenario) != null)) {
        out[categoryFor(code)].push([code, p]);
      }
    }
    return out;
  }, [perils, scenario]);

  const hasData = Object.values(grouped).some((l) => l.length > 0);
  if (!hasData) {
    return <p className="cop-empty">Aucune projection modélisée pour ce diagnostic.</p>;
  }

  return (
    <>
      <div className="cop-legend" role="group" aria-label="Légende des graphiques">
        <span className="cop-legend-item cop-legend-item--main">{scenarioLabel(scenario)}</span>
        <span className="cop-legend-item cop-legend-item--cmp">{scenarioLabel(compareScenario)}</span>
      </div>
      <div className="cop-charts">
        {Object.entries(CATEGORIES).map(([key, cat]) => {
          const entries = grouped[key as CategoryKey];
          if (!entries.length) return null;
          return (
            <CategoryCard
              key={key}
              category={cat}
              perils={entries}
              scenario={scenario}
              compareScenario={compareScenario}
            />
          );
        })}
      </div>
    </>
  );
}

/* ── Onglet Périodes retour ── */

function ReturnPeriodTab({ trajectoire }: { trajectoire: Trajectoire | null }) {
  const perils = trajectoire?.perils ?? {};
  const entries = Object.entries(perils);

  const hasData = entries.some(([, p]) => {
    const v2026 = p.points.find((pt) => pt.horizon === 2026)?.valeur;
    const v2050 = p.points.find((pt) => pt.horizon === 2050)?.valeur;
    return v2026 != null && v2050 != null;
  });
  if (!hasData) {
    return <p className="cop-empty">Périodes de retour non disponibles pour ce diagnostic.</p>;
  }

  return (
    <div className="cop-return-grid">
      {entries.map(([code, peril]) => {
        const v2026 = peril.points.find((pt) => pt.horizon === 2026)?.valeur;
        const v2050 = peril.points.find((pt) => pt.horizon === 2050)?.valeur;
        const v2100 = peril.points.find((pt) => pt.horizon === 2100)?.valeur;

        if (v2026 == null || v2050 == null) return null;

        const change2050 = v2026 > 0 ? ((v2050 - v2026) / v2026) * 100 : 0;
        const change2100 = v2100 != null && v2026 > 0 ? ((v2100 - v2026) / v2026) * 100 : null;
        const unit = uniteOf(peril);

        return (
          <article key={code} className="cop-return-card">
            <div className="cop-return-name">{peril.label}</div>
            <ul className="cop-return-list">
              <li className="cop-return-row">
                <span className="cop-return-year">2026</span>
                <span className="cop-return-value">{v2026.toFixed(1)}</span>
              </li>
              <li className="cop-return-row">
                <span className="cop-return-year">2050</span>
                <span className="cop-return-value">
                  {v2050.toFixed(1)}
                  <span className={`cop-return-change ${change2050 >= 0 ? 'cop-return-up' : 'cop-return-down'}`}>
                    {change2050 >= 0 ? '+' : ''}{change2050.toFixed(0)}%
                  </span>
                </span>
              </li>
              {change2100 != null && v2100 != null && (
                <li className="cop-return-row">
                  <span className="cop-return-year">2100</span>
                  <span className="cop-return-value">
                    {v2100.toFixed(1)}
                    <span className={`cop-return-change ${change2100 >= 0 ? 'cop-return-up' : 'cop-return-down'}`}>
                      {change2100 >= 0 ? '+' : ''}{change2100.toFixed(0)}%
                    </span>
                  </span>
                </li>
              )}
            </ul>
            {unit && <div className="cop-return-unit">{unit}</div>}
          </article>
        );
      })}
    </div>
  );
}

/* ── Onglet Qualité ── */

function QualiteTab({ trajectoire }: { trajectoire: Trajectoire | null }) {
  const perils = trajectoire?.perils ?? {};
  const points = Object.values(perils).flatMap((p) => p.points);

  const confCounts = countBy(points.map((pt) => pt.confiance));
  const resCounts = countBy(points.map((pt) => pt.resolution));

  const confLevels: { key: string; icon: string; cls: string }[] = [
    { key: 'elevee', icon: 'check_circle', cls: 'cop-conf-high' },
    { key: 'moyenne', icon: 'help', cls: 'cop-conf-medium' },
    { key: 'faible', icon: 'warning', cls: 'cop-conf-low' },
  ];
  const resLevels: { key: string; icon: string; cls: string; label: string }[] = [
    { key: 'per-building', icon: 'home', cls: 'cop-res-building', label: 'Bâtiment' },
    { key: 'commune-level', icon: 'location_city', cls: 'cop-res-other', label: 'Commune' },
    { key: 'grid-cell', icon: 'grid_on', cls: 'cop-res-other', label: 'Grille' },
  ];

  if (points.length === 0) {
    return <p className="cop-empty">Données de qualité non disponibles.</p>;
  }

  return (
    <div className="cop-conf-grid">
      <section className="cop-conf-card">
        <h3>Niveau de confiance</h3>
        <ul className="cop-conf-list">
          {confLevels.map((lvl) => {
            const count = confCounts[lvl.key] ?? 0;
            if (count === 0) return null;
            return (
              <li key={lvl.key} className="cop-conf-row">
                <md-icon className={lvl.cls}>{lvl.icon}</md-icon>
                <span className="cop-conf-name">{confLabel(lvl.key)}</span>
                <span className="cop-conf-count">{count} ind.</span>
              </li>
            );
          })}
          {Object.keys(confCounts).length === 0 && (
            <li className="cop-conf-row cop-conf-row--empty">Non renseignée</li>
          )}
        </ul>
      </section>

      <section className="cop-conf-card">
        <h3>Résolution spatiale</h3>
        <ul className="cop-conf-list">
          {resLevels.map((lvl) => {
            const count = resCounts[lvl.key] ?? 0;
            if (count === 0) return null;
            return (
              <li key={lvl.key} className="cop-conf-row">
                <md-icon className={lvl.cls}>{lvl.icon}</md-icon>
                <span className="cop-conf-name">{lvl.label}</span>
                <span className="cop-conf-count">{count} ind.</span>
              </li>
            );
          })}
          {Object.keys(resCounts).length === 0 && (
            <li className="cop-conf-row cop-conf-row--empty">Non renseignée</li>
          )}
        </ul>
      </section>
    </div>
  );
}

/* ── Onglet Tableau ── */

function TableauTab({ trajectoire, scenario }: { trajectoire: Trajectoire | null; scenario: string }) {
  const perils = trajectoire?.perils ?? {};
  const entries = Object.entries(perils);

  if (entries.length === 0) {
    return <p className="cop-empty">Aucun indicateur à afficher.</p>;
  }

  return (
    <div className="cop-table-wrap">
      <div className="cop-table-head">
        <span className="cop-table-th cop-table-th--name">Indicateur</span>
        {HORIZONS.map((h) => (
          <span key={h} className="cop-table-th cop-table-th--num">{h}</span>
        ))}
        <span className="cop-table-th cop-table-th--conf">Confiance</span>
        <span className="cop-table-th cop-table-th--res">Résolution</span>
      </div>
      {entries.map(([code, p]) => {
        const pt2026 = p.points.find((x) => x.horizon === 2026);
        const confiance = pt2026?.confiance ?? null;
        const resolution = pt2026?.resolution ?? null;

        return (
          <div className="cop-table-row" key={code}>
            <span className="cop-table-td cop-table-td--name">{p.label}</span>
            {HORIZONS.map((h) => {
              const v = valueAt(p, h, scenario);
              return (
                <span key={h} className={`cop-table-td cop-table-td--num${v == null ? ' cop-table-td--na' : ''}`}>
                  {v != null ? v.toFixed(1) : '—'}
                </span>
              );
            })}
            <span className="cop-table-td cop-table-td--badge">
              {confiance ? (
                <span className={`cop-conf ${confCls(confiance)}`}>{confLabel(confiance)}</span>
              ) : (
                '—'
              )}
            </span>
            <span className="cop-table-td cop-table-td--badge">
              {resolution ? (
                <span className={`cop-res ${resCls(resolution)}`}>{resLabel(resolution)}</span>
              ) : (
                '—'
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ── Composant principal ── */

export function CopernicusPanel({ trajectoire }: { trajectoire: Trajectoire | null }) {
  const [scenario, setScenario] = useState<string>('rcp8_5');
  const [compareScenario, setCompareScenario] = useState<string>('rcp4_5');
  const [activeTab, setActiveTab] = useState<TabId>('evolution');
  const activeTabIndex = TABS.findIndex((t) => t.id === activeTab);

  const perils = useMemo(() => trajectoire?.perils ?? {}, [trajectoire]);

  const availableScenarios = useMemo(
    () =>
      Array.from(
        new Set(
          Object.values(perils).flatMap((p) =>
            p.points
              .filter((pt) => pt.scenarios && Object.keys(pt.scenarios).length > 0)
              .flatMap((pt) => Object.keys(pt.scenarios ?? {}))
          )
        )
      ),
    [perils]
  );
  const scenarioOptions = SCENARIOS.filter((s) => availableScenarios.includes(s.key));

  /* Périls sans projection modélisée à 2100 (hors périmètre Copernicus CDS). */
  const nonModelled2100 = Object.values(perils)
    .filter((p) => !p.points.some((pt) => pt.horizon === 2100 && pt.type === 'projete'))
    .map((p) => p.label);

  const hasPerils = Object.keys(perils).length > 0;

  return (
    <section className="cop-panel" aria-label="Projection climatique Copernicus">
      <header className="cop-head">
        <div className="cop-head-row">
          <h2 className="cop-title">Projection climatique</h2>
          <span
            className="cop-chip"
            title="Indicateurs Copernicus Climate Data Store — modélisés, indicatifs, non réglementaires."
          >
            Indicatif
          </span>
        </div>
        <p className="cop-subtitle">
          Évolution modélisée de l'exposition aux risques climatiques sous les scénarios RCP du GIEC.
        </p>
      </header>

      <CopernicusStatusBanner />

      {/* Sélecteur de scénario (pilule segmentée du /zone). */}
      {scenarioOptions.length > 1 && (
        <div className="cop-controls">
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

      {/* Onglets (md-tabs Material 3). */}
      <md-tabs
        className="cop-tabs"
        activeTabIndex={activeTabIndex}
        onChange={(e: React.FormEvent<HTMLElement>) => {
          const target = e.target as HTMLElement & { activeTabIndex: number };
          const id = TABS[target.activeTabIndex]?.id;
          if (id) setActiveTab(id);
        }}
      >
        {TABS.map((t) => (
          <md-primary-tab key={t.id}>{t.label}</md-primary-tab>
        ))}
      </md-tabs>

      <div className="cop-content">
        {!hasPerils ? (
          <p className="cop-empty">
            Projection indisponible pour ce diagnostic — trajectoire non chargée (rattrapage
            automatique dès que le service répond, ou relancez le diagnostic).
          </p>
        ) : (
          <>
            {activeTab === 'evolution' && (
              <EvolutionTab perils={perils} scenario={scenario} compareScenario={compareScenario} />
            )}
            {activeTab === 'retour' && <ReturnPeriodTab trajectoire={trajectoire} />}
            {activeTab === 'qualite' && <QualiteTab trajectoire={trajectoire} />}
            {activeTab === 'tableau' && <TableauTab trajectoire={trajectoire} scenario={scenario} />}
          </>
        )}
      </div>

      <footer className="cop-footer">
        {nonModelled2100.length > 0 && (
          <p className="cop-footer-note">
            <md-icon>block</md-icon>
            <span>
              <strong>Hors périmètre Copernicus CDS</strong> — non modélisés à 2100 :{' '}
              {nonModelled2100.join(', ')}.
            </span>
          </p>
        )}
        <p className="cop-footer-source">
          <md-icon>database</md-icon>
          <span>
            Source :{' '}
            <a
              href="https://cds.climate.copernicus.eu/datasets/sis-ecde-climate-indicators"
              target="_blank"
              rel="noreferrer"
            >
              Copernicus Climate Data Store (ECMWF)
            </a>{' '}
            · indicateurs modélisés, valeur indicative · unités réelles (jours/an, °C, m/s).
          </span>
        </p>
      </footer>
    </section>
  );
}