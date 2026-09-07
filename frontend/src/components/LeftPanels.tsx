// =============================================================================
//   TYPHOON — /zone : panneaux latéraux gauches (écran France, style Fuselab)
//     · POPULATION            — 2 graphiques empilés : population (compteurs
//                                 par tranche d'âge) + densité (histogramme
//                                 de densité par bandes, axe 10→150)
//     · DAMAGES BY INDUSTRY   — pertes économiques par secteur (barres colorées)
//     · INFRASTRUCTURE        — exposabilité des réseaux & équipements vitaux
//
//   Trois panneaux indépendants, empilés dans la colonne laissée libre à
//   gauche par la console météo (bas de l'écran). Chacun possède SA PROPRE
//   barre de défilement (overflow-y: auto + scrollbar Material fine).
//   100 % Material Web (md-icon) + tokens M3 du thème — aucune dépendance
//   externe. Les valeurs sont des données de démonstration statiques tant
//   qu'aucune adresse n'est diagnostiquée.
// =============================================================================

type Industry = { name: string; value: number; icon: string; color: string };
type Infra = { name: string; value: number; icon: string; color: string };

/* Format compact pour les compteurs de population (ex. 2,1 M / 928 000). */
const fmtCompact = (v: number) =>
  v >= 1_000_000
    ? `${(v / 1_000_000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} M`
    : v.toLocaleString('fr-FR');

/* ── Données de démonstration (remplacées plus tard par les agrégats réels). */
const POPULATION_TOTAL = 2_100_000;

/* Densité de population (hab./km²) — histogramme par bandes jusqu'à 150.
   Chaque barre = part de la population vivant dans cette bande de densité.
   Le label est la borne supérieure de la bande (axe 10 → 150). */
const POP_DENSITY = [
  { label: '10', value: 12 },
  { label: '30', value: 24 },
  { label: '50', value: 46 },
  { label: '70', value: 64 },
  { label: '90', value: 82 },
  { label: '120', value: 100 },
  { label: '150', value: 58 },
];
const DENSITY_AVG = '87 hab./km²';

const INDUSTRIES: Industry[] = [
  { name: 'Energy', value: 82931, icon: 'bolt', color: '#f4b400' },
  { name: 'Manufacturing', value: 51328, icon: 'factory', color: '#4285f4' },
  { name: 'Supply Centers', value: 48330, icon: 'local_shipping', color: '#ea4335' },
  { name: 'Consumer Direct', value: 42325, icon: 'storefront', color: '#e8710a' },
  { name: 'Industrial', value: 33390, icon: 'precision_manufacturing', color: '#9334e6' },
  { name: 'Health Care', value: 29207, icon: 'medical_services', color: '#0b8043' },
  { name: 'Services', value: 24212, icon: 'support_agent', color: '#00acc1' },
];
const INFRASTRUCTURE: Infra[] = [
  { name: 'Residential', value: 50681, icon: 'home', color: '#4285f4' },
  { name: 'Roads', value: 46377, icon: 'edit_road', color: '#34a853' },
  { name: 'Commercial', value: 32440, icon: 'apartment', color: '#e8710a' },
  { name: 'Educational', value: 26339, icon: 'school', color: '#9334e6' },
  { name: 'Core', value: 1400, icon: 'grid_view', color: '#00bcd4' },
  { name: 'Cultural', value: 9691, icon: 'museum', color: '#f5455c' },
  { name: 'Hospitals', value: 9542, icon: 'local_hospital', color: '#ea4335' },
];

export function LeftPanels() {
  const maxIndustry = Math.max(...INDUSTRIES.map((i) => i.value), 1);
  const maxInfra = Math.max(...INFRASTRUCTURE.map((i) => i.value), 1);
  const maxDensity = Math.max(...POP_DENSITY.map((d) => d.value), 1);

  return (
    <aside className="side-panels" aria-label="Indicateurs de la zone">
      {/* ── Panneau 1 : POPULATION (graphique de densité) ── */}
      <section className="side-panel" aria-label="Population">
        <header className="side-panel-head">
          <h2>Population</h2>
          <span className="side-panel-count" aria-hidden="true">
            {fmtCompact(POPULATION_TOTAL)}
          </span>
        </header>
        <div className="side-panel-body side-pop-body">
          {/* ── Densité : histogramme de densité (axe 10 → 150) ── */}
          <div className="pop-chart">
            <div className="pop-chart-title">
              <span>Densité</span>
              <span className="pop-chart-sub">{DENSITY_AVG}</span>
            </div>
            <div className="dens-plot" role="img" aria-label="Répartition par densité de population">
              {POP_DENSITY.map((d) => (
                <span
                  className="dens-bar"
                  key={d.label}
                  style={{ height: `${Math.round((d.value / maxDensity) * 100)}%` }}
                />
              ))}
            </div>
            <div className="dens-axis" aria-hidden="true">
              {POP_DENSITY.map((d) => (
                <span key={d.label}>{d.label}</span>
              ))}
            </div>
            <div className="dens-axis-cap" aria-hidden="true">
              hab./km²
            </div>
          </div>
        </div>
      </section>

      {/* ── Panneau 2 : DAMAGES BY INDUSTRY ── */}
      <section className="side-panel" aria-label="Dommages par industrie">
        <header className="side-panel-head">
          <h2>Damages by Industry</h2>
          <md-icon className="side-panel-search" aria-hidden="true">
            search
          </md-icon>
        </header>
        <div className="side-panel-body">
          {INDUSTRIES.map((ind) => (
            <div className="side-row" key={ind.name}>
              <md-icon
                className="side-row-icon"
                style={{ color: ind.color }}
                aria-hidden="true"
              >
                {ind.icon}
              </md-icon>
              <span className="side-row-name">{ind.name}</span>
              <span className="side-row-value">
                {ind.value.toLocaleString('fr-FR')}
              </span>
              {/* Trait de niveau pleine largeur sous la rangée. */}
              <span className="side-row-track" aria-hidden="true">
                <span
                  className="side-row-fill"
                  style={{
                    width: `${Math.round((ind.value / maxIndustry) * 100)}%`,
                    background: ind.color,
                  }}
                />
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* ── Panneau 3 : INFRASTRUCTURE ── */}
      <section className="side-panel" aria-label="Infrastructures endommagées">
        <header className="side-panel-head">
          <h2>Infrastructure</h2>
          <md-icon className="side-panel-search" aria-hidden="true">
            search
          </md-icon>
        </header>
        <div className="side-panel-body">
          {INFRASTRUCTURE.map((infra) => (
            <div className="side-row" key={infra.name}>
              <md-icon
                className="side-row-icon"
                style={{ color: infra.color }}
                aria-hidden="true"
              >
                {infra.icon}
              </md-icon>
              <span className="side-row-name">{infra.name}</span>
              <span className="side-row-value">
                {infra.value.toLocaleString('fr-FR')}
              </span>
              {/* Trait de niveau pleine largeur sous la rangée. */}
              <span className="side-row-track" aria-hidden="true">
                <span
                  className="side-row-fill"
                  style={{
                    width: `${Math.round((infra.value / maxInfra) * 100)}%`,
                    background: infra.color,
                  }}
                />
              </span>
            </div>
          ))}
        </div>
      </section>
    </aside>
  );
}
