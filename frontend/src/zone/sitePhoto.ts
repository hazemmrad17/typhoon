// =============================================================================
//   TYPHOON — /zone : photos terrain RÉELLES du secteur (Panoramax).
//
//   Les cartes de scénarios de l'étape 2 ont besoin d'un visuel. Un fond
//   abstrait ne dit rien du lieu ; une photo d'inondation trouvée ailleurs
//   serait pire (elle ferait croire à une observation). On affiche donc la
//   photo RÉELLE la plus proche du point analysé, prise par un contributeur
//   identifié, datée et géolocalisée — contrat GET /api/photo.
//
//   Ce que la vignette porte, et qui n'est jamais mélangé :
//     · RÉEL           — l'image, sa date, son producteur, sa distance, et son
//                        écart d'orientation par rapport au point analysé ;
//     · ENVELOPPE      — le trait d'eau tracé sur la photo, qui vient du
//                        scénario (hauteur d'eau modélisée / hauteur de bâti
//                        BDNB) et est donc explicitement du modèle.
//
//   Aucune de ces fonctions ne jette : sans photo (fonds non couvert, service
//   indisponible), l'UI retombe sur son visuel abstrait et le dit.
// =============================================================================

import { API } from './config';

/* ── Contrat backend (app/schemas/photo.py) ── */

export interface SitePhoto {
  available: boolean;
  reason: string | null;
  label: string | null;
  candidates: number;
  id: string | null;
  distance_m: number | null;
  /** true = l'axe de prise de vue regarde le point analysé ; false = c'est la
   *  photo la plus PROCHE, pas la mieux orientée (la façade peut être hors champ). */
  facing_ok: boolean;
  facing_error_deg: number | null;
  view_azimuth: number | null;
  captured_at: string | null;
  thumb_url: string | null;
  sd_url: string | null;
  page_url: string | null;
  producer: string | null;
  licence: string | null;
  source: string;
  retrieved_at: string;
}

/** Photo terrain réelle la plus représentative d'un point (ou null). */
export async function fetchSitePhoto(
  lat: number,
  lon: number,
  signal?: AbortSignal
): Promise<SitePhoto | null> {
  try {
    const q = new URLSearchParams({ lat: lat.toFixed(6), lon: lon.toFixed(6) });
    const resp = await fetch(`${API}/api/photo?${q.toString()}`, { signal });
    if (!resp.ok) return null;
    return (await resp.json()) as SitePhoto;
  } catch {
    return null;
  }
}

/* ── Trait d'eau : hauteur modélisée rapportée à la hauteur de bâti ──

   Position (0 → 100) du trait sur la vignette. C'est un RAPPORT de deux
   nombres déjà affichés ailleurs dans l'app (hauteur d'eau du scénario /
   hauteur BDNB du bâtiment analysé) : la photo n'est pas calibrée, donc on ne
   prétend jamais placer une cote absolue dans l'image — seulement la part de
   la hauteur de bâti que l'eau atteindrait.

   Renvoie null si la hauteur n'est pas connue : dans ce cas aucun trait n'est
   dessiné (plutôt qu'un trait décoratif sans signification). */
export function waterLinePct(depthM: number | null, heightM: number | null): number | null {
  if (depthM == null || heightM == null) return null;
  if (!Number.isFinite(depthM) || !Number.isFinite(heightM)) return null;
  if (heightM <= 0 || depthM <= 0) return null;
  const pct = (depthM / heightM) * 100;
  return Math.round(Math.min(100, pct) * 10) / 10;
}

/** Libellé du trait d'eau (le rapport, jamais une cote absolue). */
export function waterLineLabel(depthM: number, heightM: number, pct: number): string {
  return (
    `${depthM.toFixed(2)} m d'eau modélisée — ${pct.toFixed(1)} % de la hauteur de bâti ` +
    `(${heightM.toFixed(1)} m, BDNB)`
  );
}

/** Date de prise de vue lisible (jj/mm/aaaa), ou null si absente/illisible. */
export function photoDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** Provenance affichable : « Panoramax · immergis · 25/06/2024 · etalab-2.0 ». */
export function photoCredit(photo: SitePhoto): string {
  return ['Panoramax', photo.producer, photoDate(photo.captured_at), photo.licence]
    .filter((part): part is string => !!part)
    .join(' · ');
}

/** Ce que la vignette est, en une ligne : distance, orientation, provenance.

    On n'annonce l'orientation QUE si elle est vérifiée (`facing_ok`) : sinon la
    ligne dit seulement que c'est la vue la plus proche — et le détail chiffré
    (axe de prise de vue, écart au point) reste dans l'infobulle. */
export function photoCaption(photo: SitePhoto): string {
  const at = photo.distance_m != null ? `Vue terrain à ${photo.distance_m} m` : 'Vue terrain';
  const facing = photo.facing_ok ? 'orientée sur le point' : 'la plus proche du point';
  return `${at} — ${facing} · ${photoCredit(photo)}`;
}

/** Détail chiffré de la prise de vue (infobulle) — jamais affiché comme un fait nu. */
export function photoDetail(photo: SitePhoto): string {
  const parts: string[] = [];
  if (photo.view_azimuth != null) parts.push(`axe de prise de vue ${Math.round(photo.view_azimuth)}°`);
  if (photo.facing_error_deg != null) {
    parts.push(`écart au point analysé ${Math.round(photo.facing_error_deg)}°`);
  } else {
    parts.push('orientation non renseignée par le producteur');
  }
  if (photo.candidates > 0) parts.push(`${photo.candidates} photos examinées dans le rayon`);
  return parts.join(' · ');
}
