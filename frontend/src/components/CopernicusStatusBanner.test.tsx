// =============================================================================
//   TYPHOON — CopernicusStatusBanner : tests du bouton « Lancer le
//   téléchargement » (POST /diagnostic/copernicus/download + polling 5 s).
//   Aucun appel réseau réel : fetch est mocké. Les éléments md-* étant
//   stubés en éléments simples (test/setup.ts), on interroge par texte.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { CopernicusStatusBanner, type CopernicusStatus } from './CopernicusStatusBanner';
import { API } from '../zone/config';

// Pas de fake timers : le polling 5 s du composant n'est pas nécessaire pour
// ces assertions (le fetch initial se résout en microtâche) et les fake timers
// bloquent findByText/waitFor de RTL.

function makeStatus(overrides: Partial<CopernicusStatus> = {}): CopernicusStatus {
  return {
    enabled: true,
    configured: true,
    download_complete: false,
    in_progress: false,
    last_error: null,
    cache_files: 0,
    cache_bytes: 0,
    ...overrides,
  };
}

const STATUS_URL = `${API}/diagnostic/copernicus/status`;
const DOWNLOAD_URL = `${API}/diagnostic/copernicus/download`;

describe('CopernicusStatusBanner', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the download button when configured and not downloaded', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => makeStatus() });
    render(<CopernicusStatusBanner />);
    expect(await screen.findByText('Lancer le téléchargement')).toBeInTheDocument();
  });

  it('POSTs to the download endpoint on click', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => makeStatus() });
    render(<CopernicusStatusBanner />);
    const label = await screen.findByText('Lancer le téléchargement');
    act(() => {
      label.closest('md-filled-button')?.click();
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        DOWNLOAD_URL,
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  it('shows busy state and no button while the download is in progress', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => makeStatus({ in_progress: true }) });
    render(<CopernicusStatusBanner />);
    expect(await screen.findByText(/téléchargement en cours/i)).toBeInTheDocument();
    expect(screen.queryByText('Lancer le téléchargement')).not.toBeInTheDocument();
  });

  it('renders nothing once the download is complete', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => makeStatus({ download_complete: true }) });
    render(<CopernicusStatusBanner />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(STATUS_URL));
    expect(screen.queryByText(/Copernicus/i)).not.toBeInTheDocument();
  });

  it('shows the licence link (not the button) when the licence blocks the download', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeStatus({ last_error: 'required licences not accepted' }),
    });
    render(<CopernicusStatusBanner />);
    expect(await screen.findByText(/licence à accepter/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Accepter la licence/i })).toBeInTheDocument();
    expect(screen.queryByText('Lancer le téléchargement')).not.toBeInTheDocument();
  });
});
