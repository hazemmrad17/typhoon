// =============================================================================
//   Adaptateur contrat canonique → vue RisqueReport (T014, FR-24)
//
//   Le backend sert le DiagnosticRecord canonique (POST /diagnostic/adresse).
//   Les composants de présentation (UnifiedMap, BuildingFiche, AleaCard…)
//   consomment la vue historique : cet adaptateur fait la traduction UNE
//   fois, à l'entrée — aucune donnée n'est inventée, tout champ provient du
//   record canonique.
//
//   Champs interdits (niveau/score/recommandations/copernicus) : absents du
//   record par construction (constitution §2) — l'adaptateur ne les recrée
//   jamais.
// =============================================================================

import type { AleaDetail, CatNatEvent, RisqueReport } from './config';

/** Miroir typé du contrat canonique v1.0 (backend app/schemas/diagnostic_record.py). */
export interface CanonicalAlea {
  code: string;
  libelle: string;
  present: boolean | null;
  present_commune?: boolean | null;
  zonage?: string | null;
  hauteur_eau_m?: number | null;
  zone_sismique?: string | null;
  catnat_historique?: CatNatEvent[] | null;
  per_building?: {
    method: 'point-in-polygon' | 'proximity';
    radius_m?: number | null;
    count: number;
  };
  source: string;
  url_detail?: string | null;
  erreur?: string | null;
  resolution: 'per-building' | 'commune-level' | 'commune-level-estimate';
}

export interface CanonicalRecord {
  schema_version: string;
  adresse: {
    saisie: string;
    normalisee: string;
    citycode: string;
    postcode?: string | null;
    city?: string | null;
    lat: number;
    lon: number;
    geocode_score?: number | null;
  };
  aleas: CanonicalAlea[];
  bdnb?: {
    donnees: Record<string, unknown>;
    _source: { provider: string; url: string; attribution: string; recuperee_le: string };
  } | null;
  georisques_source: {
    provider: string;
    url: string;
    attribution: string;
    recuperee_le: string;
  };
  erreurs_partielles: string[];
  genere_le: string;
  avertissement?: string;
}

/** Traduit un aléa canonique en vue historique — résolution portée telle quelle. */
export function aleaToView(a: CanonicalAlea): AleaDetail {
  return {
    code: a.code,
    libelle: a.libelle,
    present: a.present,
    present_commune: a.present_commune ?? null,
    zonage: a.zonage ?? null,
    catnat_historique: a.catnat_historique ?? null,
    source: a.source ?? 'georisques',
    url_detail: a.url_detail ?? null,
    erreur: a.erreur ?? null,
    resolution: a.resolution,
  };
}

/** DiagnosticRecord canonique -> vue consommable par les composants existants. */
export function toRisqueReportView(record: CanonicalRecord): RisqueReport {
  const bdnbDonnees = record.bdnb?.donnees ?? null;
  return {
    adresse_saisie: record.adresse.saisie,
    adresse_normalisee: record.adresse.normalisee,
    lat: record.adresse.lat,
    lon: record.adresse.lon,
    code_insee: record.adresse.citycode,
    date_generation: record.genere_le.slice(0, 10),
    alea_count: record.aleas.filter((a) => a.present === true).length,
    aleas: record.aleas.map(aleaToView),
    erreurs_partielles: record.erreurs_partielles ?? [],
    // Le bloc BDNB est aplati : `donnees.batiment` remonte au niveau courant
    // (consommateurs historiques : report.bdnb?.batiment?.batiment_groupe_id).
    bdnb: bdnbDonnees ? (bdnbDonnees as RisqueReport['bdnb']) : null,
    avertissement: record.avertissement ?? '',
  };
}
