// =============================================================================
//   TYPHOON — /zone : DISCLAIMER DU MODE VFX (constitution §2.1)
//
//   Deux niveaux de libellé, imposés par le §2.1 :
//     · principal, TOUJOURS visible en VFX : « Simulation visuelle — non
//       contractuelle » ;
//     · secondaire, seulement quand les entrées réelles sont partielles :
//       « Données partielles — rendu illustratif ».
//
//   Le mode data ne rend jamais ce composant : hors VFX, il n'y a rien à
//   démentir (les chiffres y sont sourcés).
// =============================================================================

import { vfxSourceLabel, type VfxWaterLevelSource } from '../zone/vfx/vfxInputs';

export function VfxDisclaimer({
  partial,
  source,
}: {
  /** Entrées réelles partielles (repli illustratif utilisé) ? */
  partial: boolean;
  /** Provenance de la grandeur affichée — affichée pour l'audit visuel. */
  source?: VfxWaterLevelSource;
}) {
  return (
    <div className="vfx-disclaimer" role="status" aria-live="polite">
      <span className="vfx-disclaimer-main">
        <md-icon aria-hidden="true">movie</md-icon>
        <b>Simulation visuelle — non contractuelle</b>
      </span>
      {partial ? (
        <span className="vfx-disclaimer-sub">
          Données partielles — rendu illustratif
          {source ? ` · ${vfxSourceLabel(source)}` : ''}
        </span>
      ) : (
        <span className="vfx-disclaimer-sub">
          Entrées : {source ? vfxSourceLabel(source) : 'prévision réelle'}
        </span>
      )}
    </div>
  );
}
