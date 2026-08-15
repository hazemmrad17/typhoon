// =============================================================================
//   TYPHOON — watchlist : communes/adresses suivies (vue Assurance)
//   Persisté en localStorage (même pattern que conversations.ts). Le badge
//   « nouveau CatNat » compare le nombre d'arrêtés déjà vus (`lastSeenCatNat`)
//   à la liste actuelle — les données CatNat sont déjà fetchées par le
//   diagnostic, aucun appel réseau supplémentaire pour le MVP.
// =============================================================================

export interface WatchlistEntry {
  id: string;
  /** Adresse ou commune suivie (ce qui a été ajouté depuis la carte de décision). */
  address: string;
  /** Code INSEE de la commune (vide si inconnu au moment de l'ajout). */
  citycode: string;
  /** Nombre d'arrêtés CatNat déjà vus — le badge s'allume si la liste a grandi. */
  lastSeenCatNat: number;
  addedAt: number;
}

const STORAGE_KEY = 'typhoon.watchlist';
const LATEST_KEY = 'typhoon.watchlist.latestCatNat';
const MAX_ITEMS = 50;

export function loadWatchlist(): WatchlistEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (e): e is WatchlistEntry =>
          !!e && typeof e.id === 'string' && typeof e.address === 'string'
      )
      .slice(0, MAX_ITEMS);
  } catch {
    return [];
  }
}

export function saveWatchlist(list: WatchlistEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_ITEMS)));
  } catch {
    /* quota / privé — ignorer silencieusement */
  }
}

/** Ajoute une adresse (ou la remonte) sans doublon. Retourne false si déjà suivie. */
export function addToWatchlist(
  list: WatchlistEntry[],
  address: string,
  citycode = ''
): WatchlistEntry[] {
  const trimmed = address.trim();
  if (!trimmed) return list;
  const key = trimmed.toLowerCase();
  const existing = list.find((e) => e.address.toLowerCase() === key);
  if (existing) {
    /* Déjà suivie : on remonte simplement en tête, sans doublon. */
    return [existing, ...list.filter((e) => e.id !== existing.id)];
  }
  return [
    {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      address: trimmed,
      citycode,
      lastSeenCatNat: 0,
      addedAt: Date.now(),
    },
    ...list,
  ].slice(0, MAX_ITEMS);
}

/** Met à jour le compteur d'arrêtés vus (après un diagnostic de la commune). */
export function markCatNatSeen(
  list: WatchlistEntry[],
  address: string,
  catnatCount: number
): WatchlistEntry[] {
  const key = address.trim().toLowerCase();
  return list.map((e) =>
    e.address.toLowerCase() === key ? { ...e, lastSeenCatNat: catnatCount } : e
  );
}

export function removeFromWatchlist(list: WatchlistEntry[], id: string): WatchlistEntry[] {
  return list.filter((e) => e.id !== id);
}

/** Nombre d'entrées dont le nombre d'arrêtés a grandi depuis la dernière visite. */
export function newCatNatCount(
  list: WatchlistEntry[],
  catnatByAddress: Record<string, number>
): number {
  return list.filter((e) => {
    const current = catnatByAddress[e.address.toLowerCase()];
    if (current == null) return false;
    return current > (e.lastSeenCatNat || 0);
  }).length;
}

/* ── Dernier comptage CatNat observé par adresse ──
   Mis à jour par /zone à chaque diagnostic (données déjà fetchées) : c'est
   la « référence » qui permet au badge de dire « nouveau CatNat » sans aucun
   appel réseau supplémentaire. On ne touche PAS à lastSeenCatNat ici : la
   visite explicite de l'entrée (ou « tout marquer vu ») le fait. */

export function loadCatNatLatest(): Record<string, number> {
  try {
    const raw = localStorage.getItem(LATEST_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as Record<string, number>;
  } catch {
    return {};
  }
}

export function saveCatNatLatest(map: Record<string, number>): void {
  try {
    localStorage.setItem(LATEST_KEY, JSON.stringify(map));
  } catch {
    /* ignorer */
  }
}

/** Enregistre le dernier comptage CatNat observé pour une adresse (diagnostic). */
export function recordCatNatLatest(
  map: Record<string, number>,
  address: string,
  count: number
): Record<string, number> {
  const key = address.trim().toLowerCase();
  if (!key) return map;
  return { ...map, [key]: count };
}

/** Marque toutes les entrées comme vues (lastSeen = dernier comptage observé). */
export function markAllCatNatSeen(
  list: WatchlistEntry[],
  latest: Record<string, number>
): WatchlistEntry[] {
  return list.map((e) => ({
    ...e,
    lastSeenCatNat: latest[e.address.toLowerCase()] ?? e.lastSeenCatNat,
  }));
}
