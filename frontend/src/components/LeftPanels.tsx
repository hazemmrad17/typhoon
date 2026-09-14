// =============================================================================
//   TYPHOON — /zone : panneau latéral GAUCHE (écran France)
//   Instantané dynamique selon la sélection dans la carte :
//     · aucune sélection  → repère national (chiffres INSEE de la France) ;
//     · région sélectionnée → statistiques INSEE réelles de la région + un
//                              graphique en ligne comparant les 13 régions ;
//     · adresse diagnostiquée → instantané de la commune (population /
//                              superficie / densité) via la géo-API française
//                              (geo.api.gouv.fr, données INSEE en direct).
//   Les « Damages by Industry » et « Infrastructure » (démo) ont été retirés.
// =============================================================================

import { useEffect, useState, type CSSProperties } from 'react';
import { WFS_LAYER_MAP, WMS_LAYER_MAP, type RisqueReport } from '../zone/config';

/* ── Chiffres INSEE officiels des 13 régions métropolitaines (population et
   superficie) — géo.api.gouv.fr ne sert la démographie qu'au niveau commune,
   on s'appuie donc sur un référentiel INSEE stable pour les régions. */
const REGIONS: { nom: string; pop: number; surfaceKm2: number }[] = [
  { nom: 'Auvergne-Rhône-Alpes', pop: 8_135_000, surfaceKm2: 69_711 },
  { nom: 'Bourgogne-Franche-Comté', pop: 2_791_000, surfaceKm2: 47_784 },
  { nom: 'Bretagne', pop: 3_405_000, surfaceKm2: 27_208 },
  { nom: 'Centre-Val de Loire', pop: 2_573_000, surfaceKm2: 39_151 },
  { nom: 'Corse', pop: 351_000, surfaceKm2: 8_680 },
  { nom: 'Grand Est', pop: 5_563_000, surfaceKm2: 57_433 },
  { nom: 'Hauts-de-France', pop: 5_992_000, surfaceKm2: 31_813 },
  { nom: 'Île-de-France', pop: 12_343_000, surfaceKm2: 12_011 },
  { nom: 'Normandie', pop: 3_322_000, surfaceKm2: 29_906 },
  { nom: 'Nouvelle-Aquitaine', pop: 6_105_000, surfaceKm2: 84_036 },
  { nom: 'Occitanie', pop: 6_058_000, surfaceKm2: 72_724 },
  { nom: 'Pays de la Loire', pop: 3_887_000, surfaceKm2: 32_082 },
  { nom: "Provence-Alpes-Côte d'Azur", pop: 5_116_000, surfaceKm2: 31_400 },
];

const findRegion = (name: string | null) =>
  REGIONS.find((r) => name && normalize(r.nom) === normalize(name)) || null;

const fmtCompact = (v: number) =>
  v >= 1_000_000
    ? `${(v / 1_000_000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} M`
    : v.toLocaleString('fr-FR');

/* ── Graphique en ligne : population des 13 régions, sélection mise en avant ── */
function RegionLineChart({ selected }: { selected: string }) {
  const W = 300;
  const H = 90;
  const pad = 6;
  const max = Math.max(...REGIONS.map((r) => r.pop));
  const xs = (i: number) => pad + (i * (W - pad * 2)) / (REGIONS.length - 1);
  const ys = (pop: number) => H - pad - (pop / max) * (H - pad * 2);
  const selIdx = Math.max(0, REGIONS.findIndex((r) => r.nom === selected));
  const points = REGIONS.map((r, i) => `${xs(i).toFixed(1)},${ys(r.pop).toFixed(1)}`).join(' ');

  return (
    <div className="region-chart" role="img" aria-label="Population des régions de France">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="region-chart-svg">
        {/* Ligne de référence (toutes les régions) */}
        <polyline className="region-chart-line" points={points} fill="none" />
        {/* Point de la région sélectionnée */}
        <circle
          className="region-chart-dot"
          cx={xs(selIdx)}
          cy={ys(REGIONS[selIdx].pop)}
          r="5"
        />
      </svg>
      <div className="region-chart-labels">
        <span>Régions</span>
        <span className="region-chart-hi">{selected}</span>
      </div>
    </div>
  );
}

type Commune = {
  nom: string;
  code: string;
  codeDepartement: string;
  codeRegion: string;
  population: number;
  surface: number; // hectares
};

const RESO: Record<string, string> = {
  'per-building': 'Vérifié au bâtiment',
  'commune-level': 'Présent dans la commune',
  'commune-level-estimate': 'Estimé (commune)',
};

/* Couleur par résolution (niveau de confiance du fait) : au bâtiment = le
   plus critique, commune = moyen, estimation communale = le plus incertain. */
const RESO_COLOR: Record<string, string> = {
  'per-building': '#ff3b30',
  'commune-level': '#ff9f0a',
  'commune-level-estimate': '#f0c33c',
};

/* ── Métadonnées des aléas Géorisques : icône + couleur par type de risque.
   La correspondance se fait par mot-clé dans le libellé (insensible aux
   accents), avec repli générique. Les codes varient d'un backend à l'autre,
   le libellé français est le repère stable. ── */
const HAZARD_META: { match: string[]; icon: string; color: string }[] = [
  { match: ['inondation', 'crue', 'submersion', 'inondables'], icon: 'flood', color: '#ff3b30' },
  { match: ['cyclone', 'ouragan', 'tempête'], icon: 'cyclone', color: '#ff3b30' },
  { match: ['avalanche'], icon: 'ac_unit', color: '#ff3b30' },
  { match: ['mouvement de terrain', 'éboulement', 'glissement'], icon: 'terrain', color: '#ff3b30' },
  { match: ['séisme', 'sismique'], icon: 'waves', color: '#ff9f0a' },
  { match: ['industriel', 'icpe', 'seveso'], icon: 'factory', color: '#ff9f0a' },
  { match: ['feu de forêt', 'feux de forêt', 'incendie'], icon: 'local_fire_department', color: '#ff9f0a' },
  { match: ['radon'], icon: 'science', color: '#f0c33c' },
  { match: ['argile', 'retrait', 'gonflement'], icon: 'crack', color: '#f0c33c' },
  { match: ['cavité', 'carrière', 'marnière'], icon: 'tunnel', color: '#f0c33c' },
  { match: ['canalisation', 'tmd', 'transport de matières'], icon: 'device_hub', color: '#f0c33c' },
  { match: ['nucléaire'], icon: 'radiation', color: '#f0c33c' },
];

const normalize = (s: string) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

function hazardMeta(libelle: string): { icon: string; color: string } {
  const n = normalize(libelle);
  for (const m of HAZARD_META) {
    if (m.match.some((k) => n.includes(normalize(k)))) return { icon: m.icon, color: m.color };
  }
  return { icon: 'warning', color: '#8a8f98' };
}

/* Un aléa ne peut être allumé sur la carte que si une couche existe pour lui
   (WFS vecteur ou WMS raster). Ouvrir l'œil d'un aléa sans couche — les vents
   cycloniques, par exemple — n'afficherait rien : on ne le fait pas d'office. */
const hasMapLayer = (code: string) => Boolean(WMS_LAYER_MAP[code] || WFS_LAYER_MAP[code]);

export function LeftPanels({
  place,
  report,
  onVisibleChange,
}: {
  place: string | null;
  report: RisqueReport | null;
  /** Remonte les aléas que l'utilisateur a explicitement rendus visibles
   *  (toggles œil) à Zone.tsx : ce sont les SEULS couches WFS/WMS affichées
   *  sur la carte — aucun allumage automatique au diagnostic. */
  onVisibleChange?: (visible: Set<string>) => void;
}) {
  const codeInsee = report?.code_insee ?? null;
  const [commune, setCommune] = useState<Commune | null>(null);
  const [communeErr, setCommuneErr] = useState(false);
  const region = findRegion(place);

  /* Données INSEE réelles de la commune (géo-API française). */
  useEffect(() => {
    if (!codeInsee) {
      setCommune(null);
      return;
    }
    let alive = true;
    setCommuneErr(false);
    fetch(
      `https://geo.api.gouv.fr/communes/${codeInsee}?fields=nom,code,codeDepartement,codeRegion,population,surface`
    )
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        if (alive) setCommune(d);
      })
      .catch(() => {
        if (alive) setCommuneErr(true);
      });
    return () => {
      alive = false;
    };
  }, [codeInsee]);

  /* TOUS les aléas Géorisques du rapport (présents ET absents) — les
     absents sont grisés « Non détecté ». Chaque rangée garde son toggle œil.
     À l'arrivée d'un diagnostic, les aléas AUXQUELS L'ADRESSE EST EXPOSÉE
     (`present`) et qui disposent d'une couche cartographique s'allument
     d'office : la carte montre immédiatement ce qui concerne le bien, au
     lieu d'un panneau entièrement éteint. Tout le reste reste éteint et
     s'ouvre à la main. */
  const hazards = report?.aleas || [];
  const [shownHazards, setShownHazards] = useState<Set<string>>(new Set());
  const toggleHazard = (code: string) =>
    setShownHazards((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  const presentCount = hazards.filter((a) => a.present).length;

  /* Aléas « concernés » : détectés au diagnostic ET dessinables. */
  const concernedCodes = hazards
    .filter((a) => a.present && hasMapLayer(a.code))
    .map((a) => a.code);

  /* Signature stable des faits : elle ne change que si l'adresse change ou si
     la détection bouge — pas à chaque rendu (le tableau `aleas` est recréé à
     chaque rendu, il ne peut donc pas servir de dépendance). */
  const hazardSignature = `${report?.adresse_normalisee ?? ''}#${hazards
    .map((h) => `${h.code}:${h.present ? 1 : 0}`)
    .join('|')}`;

  /* Nouveau diagnostic → on rallume l'ensemble « concernés ». Les choix
     manuels de l'utilisateur ne sont pas écrasés : cet effet ne se déclenche
     que lorsque les faits eux-mêmes changent. */
  useEffect(() => {
    setShownHazards(new Set(concernedCodes));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hazardSignature]);

  /* État du bouton global : « tout » se juge sur la liste entière, pas sur un
     ensemble vide — sinon il afficherait « Tout cacher » avec 3 aléas sur 13. */
  const allShown = hazards.length > 0 && shownHazards.size === hazards.length;

  /* Synchronise la liste des aléas visibles avec Zone.tsx (→ visibleLayerKeys
     de la carte : seuls ces aléas chargent leurs couches WFS/WMS). */
  useEffect(() => {
    onVisibleChange?.(shownHazards);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownHazards]);

  /* ── Vue nationale (aucune sélection) ── */
  const FRANCE = { nom: 'France', population: 68_373_000, surface: 632_733.9 };

  /* ── Vue région sélectionnée ── */
  if (!report && region) {
    return (
      <aside className="side-panels" aria-label="Indicateurs de la zone">
        <section className="side-panel" aria-label={region.nom}>
          <header className="side-panel-head">
            <h2>{region.nom}</h2>
            <span className="side-panel-count" aria-hidden="true">Région</span>
          </header>
          <div className="side-panel-body">
            <RegionLineChart selected={region.nom} />
            <div className="side-row">
              <md-icon className="side-row-icon" aria-hidden="true">groups</md-icon>
              <span className="side-row-name">Population</span>
              <span className="side-row-value">{fmtCompact(region.pop)}</span>
            </div>
            <div className="side-row">
              <md-icon className="side-row-icon" aria-hidden="true">terrain</md-icon>
              <span className="side-row-name">Superficie</span>
              <span className="side-row-value">{region.surfaceKm2.toLocaleString('fr-FR')} km²</span>
            </div>
            <div className="side-row">
              <md-icon className="side-row-icon" aria-hidden="true">speed</md-icon>
              <span className="side-row-name">Densité</span>
              <span className="side-row-value">
                {Math.round(region.pop / region.surfaceKm2).toLocaleString('fr-FR')} hab./km²
              </span>
            </div>
            <div className="side-hint">
              <md-icon aria-hidden="true">info</md-icon>
              <span>Chiffres INSEE régionaux. Saisissez une adresse pour l'instantané de la commune.</span>
            </div>
          </div>
        </section>
        <section className="side-panel side-panel--grow" aria-label="Aléas">
          <header className="side-panel-head">
            <h2>Aléas présents</h2>
          </header>
          <div className="side-panel-body side-empty">
            <md-icon aria-hidden="true">location_city</md-icon>
            <span>Entrez une adresse pour voir les aléas de la commune</span>
          </div>
        </section>
      </aside>
    );
  }

  /* ── Vue nationale (aucune sélection / région inconnue) ── */
  if (!report) {
    return (
      <aside className="side-panels" aria-label="Indicateurs de la zone">
        <section className="side-panel" aria-label="France">
          <header className="side-panel-head">
            <h2>{place ?? FRANCE.nom}</h2>
            <span className="side-panel-count" aria-hidden="true">Vue nationale</span>
          </header>
          <div className="side-panel-body">
            <div className="side-row">
              <md-icon className="side-row-icon" aria-hidden="true">groups</md-icon>
              <span className="side-row-name">Population</span>
              <span className="side-row-value">{fmtCompact(FRANCE.population)}</span>
            </div>
            <div className="side-row">
              <md-icon className="side-row-icon" aria-hidden="true">terrain</md-icon>
              <span className="side-row-name">Superficie</span>
              <span className="side-row-value">{FRANCE.surface.toLocaleString('fr-FR')} km²</span>
            </div>
            <div className="side-row">
              <md-icon className="side-row-icon" aria-hidden="true">speed</md-icon>
              <span className="side-row-name">Densité</span>
              <span className="side-row-value">
                {Math.round(FRANCE.population / FRANCE.surface).toLocaleString('fr-FR')} hab./km²
              </span>
            </div>
            <div className="side-hint">
              <md-icon aria-hidden="true">info</md-icon>
              <span>Chiffres INSEE nationaux. Sélectionnez une région ou saisissez une adresse.</span>
            </div>
          </div>
        </section>
        <section className="side-panel side-panel--grow" aria-label="Aléas">
          <header className="side-panel-head">
            <h2>Aléas présents</h2>
          </header>
          <div className="side-panel-body side-empty">
            <md-icon aria-hidden="true">location_city</md-icon>
            <span>Entrez une adresse pour voir les aléas de la commune</span>
          </div>
        </section>
      </aside>
    );
  }

  /* ── Vue commune (adresse diagnostiquée) ── */
  const density = commune && commune.surface > 0
    ? Math.round(commune.population / (commune.surface / 100))
    : null;
  const areaKm2 = commune ? commune.surface / 100 : null;

  return (
    <aside className="side-panels" aria-label="Indicateurs de la zone">
      <section className="side-panel" aria-label="Commune">
        <header className="side-panel-head">
          <h2>{commune?.nom ?? place ?? 'Commune'}</h2>
          {commune && (
            <span className="side-panel-count" aria-hidden="true">INSEE {commune.code}</span>
          )}
        </header>
        <div className="side-panel-body">
          {commune ? (
            <>
              <div className="side-row">
                <md-icon className="side-row-icon" aria-hidden="true">groups</md-icon>
                <span className="side-row-name">Population</span>
                <span className="side-row-value">{fmtCompact(commune.population)}</span>
              </div>
              <div className="side-row">
                <md-icon className="side-row-icon" aria-hidden="true">terrain</md-icon>
                <span className="side-row-name">Superficie</span>
                <span className="side-row-value">
                  {areaKm2 != null ? `${areaKm2.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km²` : '—'}
                </span>
              </div>
              <div className="side-row">
                <md-icon className="side-row-icon" aria-hidden="true">speed</md-icon>
                <span className="side-row-name">Densité</span>
                <span className="side-row-value">
                  {density != null ? `${density.toLocaleString('fr-FR')} hab./km²` : '—'}
                </span>
              </div>
              {commune.codeDepartement && (
                <div className="side-row">
                  <md-icon className="side-row-icon" aria-hidden="true">map</md-icon>
                  <span className="side-row-name">Département</span>
                  <span className="side-row-value">{commune.codeDepartement}</span>
                </div>
              )}
            </>
          ) : (
            <div className="side-empty">
              <md-icon aria-hidden="true">hourglass_empty</md-icon>
              <span>{communeErr ? 'Données INSEE indisponibles' : 'Chargement des données INSEE…'}</span>
            </div>
          )}
        </div>
      </section>

      <section className="side-panel side-panel--grow" aria-label="Aléas Géorisques">
        <header className="side-panel-head">
          <h2>Aléas Géorisques</h2>
          <span className="side-panel-count" aria-hidden="true">{presentCount} / {hazards.length}</span>
          <button
            type="button"
            className="hazard-toggle-all"
            onClick={() =>
              setShownHazards(allShown ? new Set() : new Set(hazards.map((h) => h.code)))
            }
            aria-label={allShown ? 'Cacher tous les aléas' : 'Afficher tous les aléas'}
            title={allShown ? 'Tout cacher' : 'Tout afficher'}
          >
            {/* Icône = état courant : œil ouvert tant que tout est visible. */}
            <md-icon aria-hidden="true">
              {allShown ? 'visibility' : 'visibility_off'}
            </md-icon>
            <span>{allShown ? 'Tout cacher' : 'Tout afficher'}</span>
          </button>
        </header>
        <div className="side-panel-body">
          {hazards.length === 0 ? (
            <div className="side-empty">
              <md-icon aria-hidden="true">verified</md-icon>
              <span>Aucun aléa Géorisques renseigné pour cette adresse</span>
            </div>
          ) : (
            hazards.map((a) => {
              const present = !!a.present;
              const meta = hazardMeta(a.libelle);
              const resColor = a.resolution ? RESO_COLOR[a.resolution] : meta.color;
              const isShown = shownHazards.has(a.code);
              const rowColor = present ? meta.color : '#8a8f98';
              return (
                <div
                  className={`hazard-row${present ? ' hazard-row--concerned' : ' hazard-row--muted'}${isShown ? '' : ' hazard-row--hidden'}`}
                  key={a.code}
                  style={{ '--hazard-c': rowColor, '--res-c': resColor } as CSSProperties}
                >
                  <span className="hazard-ico" aria-hidden="true">
                    <md-icon>{meta.icon}</md-icon>
                  </span>
                  <span className="hazard-body">
                    <span className="hazard-name">{a.libelle}</span>
                    {isShown && (
                      <span className="hazard-meta">
                        {present ? (
                          <span className="hazard-badge" style={{ color: resColor, borderColor: resColor }}>
                            {a.resolution ? RESO[a.resolution] ?? a.resolution : 'Signalé'}
                          </span>
                        ) : (
                          <span className="hazard-badge hazard-badge--na">Non détecté</span>
                        )}
                        {a.catnat_historique && a.catnat_historique.length > 0 && (
                          <span className="hazard-catnat">
                            {a.catnat_historique.length} CatNat
                          </span>
                        )}
                      </span>
                    )}
                  </span>
                  <button
                    type="button"
                    className="hazard-toggle"
                    onClick={() => toggleHazard(a.code)}
                    aria-label={isShown ? `Masquer ${a.libelle}` : `Afficher ${a.libelle}`}
                    aria-pressed={isShown}
                    title={isShown ? 'Masquer' : 'Afficher sur la carte'}
                  >
                    {/* Icône = état courant de la couche (œil ouvert = visible). */}
                    <md-icon aria-hidden="true">{isShown ? 'visibility' : 'visibility_off'}</md-icon>
                  </button>
                </div>
              );
            })
          )}
        </div>
      </section>
    </aside>
  );
}