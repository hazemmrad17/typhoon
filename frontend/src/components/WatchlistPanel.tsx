// =============================================================================
//   TYPHOON — WatchlistPanel : communes/adresses suivies (vue Assurance)
//   Rendu de la store watchlist (localStorage) : liste + badge « nouveau
//   arrêté CatNat » quand la commune a plus d'arrêtés que lors de la dernière
//   visite. Cliquer une entrée relance le diagnostic de l'adresse.
// =============================================================================

import { type WatchlistEntry } from '../zone/watchlist';

export function WatchlistPanel({
  entries,
  newCatNat,
  onOpen,
  onRemove,
}: {
  entries: WatchlistEntry[];
  /** Nombre d'entrées avec un nouveau CatNat depuis la dernière visite. */
  newCatNat: number;
  onOpen: (address: string) => void;
  onRemove: (id: string) => void;
}) {
  if (entries.length === 0) {
    return (
      <div className="watchlist-empty">
        <md-icon>bookmark_border</md-icon>
        <h2>Watchlist vide</h2>
        <p>
          Depuis la carte de décision, cliquez «&nbsp;Ajouter à la
          watchlist&nbsp;» pour suivre une adresse et être alerté des nouveaux
          arrêtés CatNat de sa commune.
        </p>
      </div>
    );
  }

  return (
    <div className="watchlist">
      <header className="watchlist-header">
        <div className="watchlist-title">
          <h2>Watchlist</h2>
          {newCatNat > 0 && (
            <span className="watchlist-badge" title="Nouveaux arrêtés CatNat depuis la dernière visite">
              <md-icon>notifications_active</md-icon>
              {newCatNat} nouveau{newCatNat > 1 ? 'x' : ''} CatNat
            </span>
          )}
        </div>
        <p className="watchlist-meta">
          {entries.length} adresse{entries.length > 1 ? 's' : ''} suivie
          {entries.length > 1 ? 's' : ''} — alertes CatNat de la commune
        </p>
      </header>

      <md-list className="watchlist-list">
        {entries.map((e) => (
          <div className="watchlist-item" key={e.id}>
            <md-list-item
              type="button"
              onClick={() => onOpen(e.address)}
              aria-label={`Diagnostiquer ${e.address}`}
            >
              <md-icon slot="start">bookmark</md-icon>
              <span slot="headline">{e.address}</span>
              {e.citycode ? (
                <span slot="supporting-text">Code INSEE {e.citycode}</span>
              ) : null}
              {e.lastSeenCatNat > 0 && (
                <span slot="trailing-supporting-text">
                  {e.lastSeenCatNat} arrêté{e.lastSeenCatNat > 1 ? 's' : ''}
                </span>
              )}
            </md-list-item>
            <md-icon-button
              className="watchlist-remove"
              aria-label={`Retirer ${e.address} de la watchlist`}
              title="Retirer de la watchlist"
              onClick={() => onRemove(e.id)}
            >
              <md-icon>close</md-icon>
            </md-icon-button>
          </div>
        ))}
      </md-list>
    </div>
  );
}
