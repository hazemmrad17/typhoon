// =============================================================================
//   TYPHOON — ProvenancePanel : panneau « Sources & provenance » (vue Assurance)
//   Liste, péril par péril, la traçabilité de chaque point de la trajectoire
//   (source · date · résolution · confiance) — toute la donnée vient des
//   TrajectoirePoint déjà présents dans la réponse /diagnostic/fast et des
//   AleaDetail. Aucun appel réseau : c'est purement du rendu.
// =============================================================================

import type { AleaDetail, Trajectoire } from '../zone/config';

/* Libellé lisible d'une résolution de point. */
function resolutionLabel(r: string | null): string {
  switch (r) {
    case 'per-building':
      return 'Par bâtiment (vérification polygonale)';
    case 'commune-level':
      return 'Communale';
    case 'grid-cell':
      return 'Cellule grille climatique';
    default:
      return '—';
  }
}

function confidenceLabel(c: string | null): string {
  switch (c) {
    case 'elevee':
      return 'Élevée';
    case 'moyenne':
      return 'Moyenne';
    case 'faible':
      return 'Faible';
    default:
      return '—';
  }
}

export function ProvenancePanel({
  aleas,
  trajectoire,
  onClose,
}: {
  aleas: AleaDetail[];
  trajectoire: Trajectoire | null;
  onClose: () => void;
}) {
  const perils = trajectoire?.perils ?? {};
  const perilEntries = Object.entries(perils);

  /* Aléas présents sans points de trajectoire (ex. icpe, feu de forêt) :
     on affiche la source AleaDetail à défaut. */
  const aleaWithoutTrajectory = aleas.filter(
    (a) => a.present === true && !(a.code in perils)
  );

  return (
    <div className="provenance-overlay" role="presentation" onMouseDown={onClose}>
      <aside
        className="provenance-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Sources et provenance"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="provenance-head">
          <div className="provenance-title">
            <md-icon>database</md-icon>
            <h2>Sources &amp; provenance</h2>
          </div>
          <md-icon-button
            aria-label="Fermer le panneau de provenance"
            onClick={onClose}
          >
            <md-icon>close</md-icon>
          </md-icon-button>
        </header>

        <p className="provenance-intro">
          Niveau de résolution et provenance de chaque valeur de la trajectoire
          climatique, par péril et par horizon.
        </p>

        <div className="provenance-body">
          {perilEntries.length === 0 && aleaWithoutTrajectory.length === 0 ? (
            <p className="provenance-empty">
              Aucune donnée de trajectoire disponible pour ce diagnostic.
            </p>
          ) : (
            <>
              {perilEntries.map(([code, p]) => (
                <section className="provenance-peril" key={code}>
                  <h3>{p.label}</h3>
                  <div className="provenance-table">
                    <div className="prov-row prov-head">
                      <span>Horizon</span>
                      <span>Source</span>
                      <span>Date</span>
                      <span>Résolution</span>
                      <span>Confiance</span>
                    </div>
                    {p.points.map((pt) => (
                      <div className="prov-row" key={pt.horizon}>
                        <span className="prov-horizon">{pt.horizon}</span>
                        <span className="prov-source" title={pt.source ?? ''}>
                          {pt.source ?? '—'}
                        </span>
                        <span className="prov-date">{pt.date_source ?? '—'}</span>
                        <span className="prov-resolution">
                          {resolutionLabel(pt.resolution)}
                        </span>
                        <span className="prov-confidence">
                          {confidenceLabel(pt.confiance)}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              ))}

              {aleaWithoutTrajectory.map((a) => (
                <section className="provenance-peril" key={a.code}>
                  <h3>{a.libelle}</h3>
                  <div className="provenance-table">
                    <div className="prov-row prov-head">
                      <span>Source</span>
                      <span>Détail</span>
                    </div>
                    <div className="prov-row">
                      <span className="prov-source" title={a.source ?? ''}>
                        {a.source ?? 'Géorisques'}
                      </span>
                      <span className="prov-date">{a.url_detail ?? '—'}</span>
                    </div>
                  </div>
                </section>
              ))}
            </>
          )}
        </div>

        <footer className="provenance-foot">
          Données publiques Géorisques (BRGM/MTE), BDNB, Open-Meteo et
          Copernicus CDS — voir le détail par point dans la carte de décision.
        </footer>
      </aside>
    </div>
  );
}
