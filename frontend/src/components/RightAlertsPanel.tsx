// =============================================================================
//   TYPHOON — /zone : panneau latéral DROIT — ALERTES (style Behance)
//   Colonne défilante de cartes d'alerte, une par zone / actif du portefeuille.
//   Chaque carte est volontairement MINIMALE, façon référence :
//     · ligne du haut : type d'alerte en capitales (CRUE, OURAGAN…) +
//                       badge de statut (ATTENDU / EN COURS) à droite ;
//     · ligne du bas  : localisation (ville, code postal).
//   La carte « active » est teintée de la couleur du risque ; les autres
//   restent sur surface sombre. Aucune icône, bande ou ligne superflue.
//   100 % Material Web + tokens M3 — données de démonstration.
// =============================================================================

type Alert = {
  id: string;
  kind: string; // « CRUE », « OURAGAN » …
  place: string; // « Nice (06000) »
  level: 'expected' | 'active';
};

/* Alertes de démonstration — une par zone/actif du portefeuille. */
const ALERTS: Alert[] = [
  { id: 'a1', kind: 'CRUE', place: 'Nice (06000)', level: 'active' },
  { id: 'a2', kind: 'OURAGAN', place: 'Antibes (06600)', level: 'expected' },
  { id: 'a3', kind: 'CRUE', place: 'Cannes (06400)', level: 'expected' },
  { id: 'a4', kind: 'TSUNAMI', place: 'Menton (06500)', level: 'expected' },
  { id: 'a5', kind: 'SÉISME', place: 'Grasse (06130)', level: 'expected' },
  { id: 'a6', kind: 'CRUE', place: 'Vence (06140)', level: 'expected' },
  { id: 'a7', kind: 'SUBVERSION MARINE', place: 'Villeneuve-Loubet (06270)', level: 'expected' },
  { id: 'a8', kind: 'CRUE', place: 'Cagnes-sur-Mer (06800)', level: 'expected' },
  { id: 'a9', kind: 'SÉISME', place: 'Puget-Théniers (06260)', level: 'expected' },
  { id: 'a10', kind: 'CRUE', place: 'Saint-Laurent-du-Var (06700)', level: 'expected' },
];

export function RightAlertsPanel() {
  const activeCount = ALERTS.filter((a) => a.level === 'active').length;

  return (
    <aside className="right-panels" aria-label="Alertes en cours">
      <section className="side-panel right-panel" aria-label="Alertes">
        <header className="side-panel-head">
          <h2>Alertes</h2>
          <span className="alert-count" aria-hidden="true">
            {activeCount} active
          </span>
          <md-icon className="side-panel-search" aria-hidden="true">
            search
          </md-icon>
        </header>
        <div className="alert-list">
          {ALERTS.map((a) => (
            <article
              className={`alert-card${a.level === 'active' ? ' alert-active' : ''}`}
              key={a.id}
            >
              <div className="alert-top">
                <span className="alert-kind">{a.kind}</span>
                <span className={`alert-badge${a.level === 'active' ? ' on' : ''}`}>
                  {a.level === 'active' ? 'EN COURS' : 'ATTENDU'}
                </span>
              </div>
              <span className="alert-place">{a.place}</span>
            </article>
          ))}
        </div>
      </section>
    </aside>
  );
}
