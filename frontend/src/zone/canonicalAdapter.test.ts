// T014 — l'adaptateur contrat canonique → vue ne doit rien inventer.
import { describe, expect, it } from 'vitest';
import { toRisqueReportView, type CanonicalRecord } from './canonicalAdapter';

const record: CanonicalRecord = {
  schema_version: '1.0',
  adresse: {
    saisie: '10 rue x',
    normalisee: '10 Rue X 75004 Paris',
    citycode: '75056',
    postcode: '75004',
    city: 'Paris',
    lat: 48.8566,
    lon: 2.3522,
    geocode_score: 0.95,
  },
  aleas: [
    {
      code: 'inondation',
      libelle: 'Inondation',
      present: true,
      present_commune: true,
      zonage: 'Dans un périmètre PPR inondation',
      catnat_historique: [],
      per_building: { method: 'point-in-polygon', radius_m: null, count: 2 },
      source: 'georisques',
      url_detail: 'https://x',
      erreur: null,
      resolution: 'per-building',
    },
    {
      code: 'rga',
      libelle: 'Retrait-gonflement des argiles',
      present: false,
      resolution: 'commune-level-estimate',
      source: 'georisques',
    },
  ],
  bdnb: {
    donnees: {
      batiment: { batiment_groupe_id: 'bdnb-bg-1', mat_mur_txt: 'pierre' },
      autres_batiments_meme_adresse: [],
    },
    _source: {
      provider: 'BDNB',
      url: 'https://api.bdnb.io',
      attribution: 'Source BDNB — données à jour au 2026-07-01',
      recuperee_le: '2026-08-25T10:00:00+00:00',
    },
  },
  georisques_source: {
    provider: 'Géorisques',
    url: 'https://www.georisques.gouv.fr',
    attribution: 'Source Géorisques — données à jour au 2026-07-01',
    recuperee_le: '2026-08-25T10:00:01+00:00',
  },
  erreurs_partielles: ['bdnb: ConnectTimeout: boom'],
  genere_le: '2026-08-25T10:00:02+00:00',
  avertissement: 'Ce rapport agrège…',
};

describe('toRisqueReportView', () => {
  const view = toRisqueReportView(record);

  it('mappe les champs d’adresse et de génération', () => {
    expect(view.adresse_saisie).toBe('10 rue x');
    expect(view.adresse_normalisee).toBe('10 Rue X 75004 Paris');
    expect(view.code_insee).toBe('75056');
    expect(view.lat).toBe(48.8566);
    expect(view.date_generation).toBe('2026-08-25');
  });

  it('conserve les aléas avec leur résolution canonique', () => {
    expect(view.aleas).toHaveLength(2);
    expect(view.aleas[0].resolution).toBe('per-building');
    expect(view.aleas[1].resolution).toBe('commune-level-estimate');
    expect(view.aleas[1].present).toBe(false);
    expect(view.alea_count).toBe(1);
  });

  it('aplatit le bloc BDNB verbatim (batiment remonte)', () => {
    expect((view.bdnb as any)?.batiment?.batiment_groupe_id).toBe('bdnb-bg-1');
    expect((view.bdnb as any)?.mat_mur_txt).toBeUndefined(); // donnees.batiment seulement aplati d'un niveau
  });

  it('ne recrée jamais les champs interdits', () => {
    expect((view as any).niveau).toBeUndefined();
    expect((view as any).score).toBeUndefined();
    expect((view as any).recommandations).toBeUndefined();
    expect((view as any).copernicus).toBeUndefined();
  });

  it('transmet les erreurs partielles et l’avertissement', () => {
    expect(view.erreurs_partielles).toContain('bdnb: ConnectTimeout: boom');
    expect(view.avertissement).toContain('agrège');
  });
});
