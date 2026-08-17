// =============================================================================
//   TYPHOON — CopernicusStatusBanner : état du téléchargement CDS (Décision)
//   Interroge GET /diagnostic/copernicus/status (sans appel réseau CDS côté
//   serveur — uniquement des marqueurs locaux) et affiche, tant que le cache
//   n'est pas prêt :
//     · cache absent → bouton « Lancer le téléchargement » (POST
//       /diagnostic/copernicus/download, thread daemon côté serveur) puis
//       polling 5 s jusqu'à download_complete
//     · téléchargement en cours (file CDS) → « en cours », lien licence si 403
//     · clé/config absente                    → « non configuré »
//     · cache prêt                            → plus rien (masqué)
// =============================================================================

import { useEffect, useRef, useState } from 'react';
import { API } from '../zone/config';

export interface CopernicusStatus {
  enabled: boolean;
  configured: boolean;
  download_complete: boolean;
  in_progress: boolean;
  last_error: string | null;
  cache_files: number;
  cache_bytes: number;
}

export function CopernicusStatusBanner() {
  const [status, setStatus] = useState<CopernicusStatus | null>(null);
  const [hidden, setHidden] = useState(false);
  const [starting, setStarting] = useState(false);
  const pollTimer = useRef<number | null>(null);

  async function refreshStatus(cancelled: () => boolean) {
    try {
      const resp = await fetch(`${API}/diagnostic/copernicus/status`);
      if (!resp.ok) return;
      const s = (await resp.json()) as CopernicusStatus;
      if (cancelled()) return;
      setStatus(s);
      /* Cache prêt ou CDS désactivé → plus rien à afficher. */
      if (s.download_complete || !s.enabled) {
        setHidden(true);
        if (pollTimer.current) window.clearInterval(pollTimer.current);
        return;
      }
      setHidden(false);
    } catch {
      /* backend down — retry next tick */
    }
  }

  /* Polling léger (5 s) tant que le téléchargement n'est pas terminé. */
  useEffect(() => {
    let cancelled = false;
    const isCancelled = () => cancelled;
    void refreshStatus(isCancelled);
    pollTimer.current = window.setInterval(() => void refreshStatus(isCancelled), 5000);
    return () => {
      cancelled = true;
      if (pollTimer.current) window.clearInterval(pollTimer.current);
    };
  }, []);

  /* Déclenche le téléchargement CDS une seule fois (idempotent côté serveur :
     started:false + reason in_progress/already_complete → rien à faire). */
  async function startDownload() {
    if (starting || status?.in_progress) return;
    setStarting(true);
    try {
      await fetch(`${API}/diagnostic/copernicus/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: false }),
      });
      /* 200 → lancé ; 409 (non configuré) → le refresh montre configured:false. */
      await refreshStatus(() => false);
    } catch {
      /* backend down — le polling reprendra tout seul */
    } finally {
      setStarting(false);
    }
  }

  if (hidden || !status || !status.enabled || status.download_complete) return null;

  /* Licence non acceptée (403 « required licences not accepted ») — lien direct. */
  const licenceBlocked = /required licences not accepted|licences? not accepted/i.test(
    status.last_error || ''
  );

  return (
    <div className={`cds-banner${status.in_progress ? ' cds-banner--busy' : ''}${licenceBlocked ? ' cds-banner--blocked' : ''}`} role="status">
      <md-icon>
        {status.in_progress ? 'sync' : licenceBlocked ? 'vpn_key_off' : 'cloud_download'}
      </md-icon>
      <div className="cds-banner-body">
        <span className="cds-banner-title">
          {status.in_progress
            ? 'Données climatiques 2100 (Copernicus CDS) : téléchargement en cours'
            : licenceBlocked
              ? 'Copernicus CDS : licence à accepter'
              : !status.configured
                ? 'Copernicus CDS : non configuré'
                : 'Données climatiques 2100 (Copernicus CDS) : premier téléchargement'}
        </span>
        <span className="cds-banner-text">
          {status.in_progress
            ? 'Le téléchargement peut prendre plusieurs minutes (file d’attente CDS). Les horizons 2026/2050 restent disponibles ; 2100 se remplira automatiquement.'
            : licenceBlocked
              ? 'Acceptez la licence CC-BY sur votre compte CDS pour débloquer le point 2100 et la comparaison RCP 4.5/8.5.'
              : 'Lancez le téléchargement une fois : les horizons 2026/2050 restent disponibles et 2100 se remplira ensuite automatiquement.'}
        </span>
        {licenceBlocked && (
          <a
            className="cds-banner-link"
            href="https://cds.climate.copernicus.eu/datasets/sis-ecde-climate-indicators?tab=download#manage-licences"
            target="_blank"
            rel="noopener"
          >
            Accepter la licence
            <md-icon>open_in_new</md-icon>
          </a>
        )}
        {!licenceBlocked && status.configured && !status.in_progress && (
          <md-filled-button
            className="cds-banner-cta"
            disabled={starting}
            onClick={() => void startDownload()}
          >
            {starting ? 'Lancement…' : 'Lancer le téléchargement'}
            <md-icon slot="icon">{starting ? 'hourglass_top' : 'download'}</md-icon>
          </md-filled-button>
        )}
      </div>
    </div>
  );
}
