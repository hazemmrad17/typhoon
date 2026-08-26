// =============================================================================
//   TYPHOON — /zone : export PDF du rapport d'analyse IA (jsPDF)
//   Génère un PDF A4 « façon product » sans aucun appel réseau :
//     · bande d'en-tête de marque (logo Typhon, liseré accent)
//     · métadonnées d'adresse (INSEE, GPS, date)
//     · score de risque global (jauge D03 + pastille)
//     · tableau des aléas recensés (statut · niveau · score)
//     · fiche du bien BDNB (si disponible)
//     · sections du rapport Mistral + synthèse encadrée + obligations
//     · pied de page paginé (sources, page X/Y)
// =============================================================================

import { jsPDF } from 'jspdf';
import { bandForResolution } from './config';

/* ── Palette PDF (alignée sur la marque Typhon) ── */
const NAVY = '#0C2233';
const NAVY_LIGHT = '#16374F';
const ACCENT = '#4C3F91';
const INK = '#1A2733';
const MUTED = '#5B6B7A';
const LINE = '#C9D6E0';
const TINT = '#EDF4F9';
const ROW_ALT = '#F6FAFD';
const OK = '#2E7D5B';
const WARN_TINT = '#FBF6EA';
const WARN_INK = '#8A6D1F';
const WHITE_60 = '#B9CCDA';

const PAGE_W = 210;
const PAGE_H = 297;
const M = 16; // marge gauche/droite
const CW = PAGE_W - 2 * M; // largeur utile
const FOOTER_TOP = PAGE_H - 12;
const SAFE_BOTTOM = PAGE_H - 16;

/* Logo Typhon (blanc, fond transparent) encodé en dur pour un export 100 %
   hors-ligne. viewBox 674.53 × 119.6 (aspect ≈ 5.639). */
const TYPHOON_WORDMARK_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg id="Layer_2" data-name="Layer 2" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 674.53 119.6">
  <defs>
    <style>
      .cls-1 {
        fill: #fff;
      }

      .cls-2 {
        fill: none;
        stroke: #fff;
        stroke-miterlimit: 10;
        stroke-width: 2px;
      }
    </style>
  </defs>
  <g id="Layer_1-2" data-name="Layer 1">
    <g>
      <path class="cls-1" d="M74.77,0v13.34l14.91.78V1.18l29.43,4.32v37.67c-8.59-.44-17.13-1.71-25.71-2.35-20.86-1.56-42.32-1.83-63.17-.39-9.75.67-19.47,2.21-29.24,2.74V5.49L30.43,1.18v12.95l14.91-.78V0h29.43Z"/>
      <polygon class="cls-1" points="60.25 85.94 60.25 118.9 1 118.9 1 87.51 22.37 86.32 60.25 85.94"/>
      <path class="cls-2" d="M90.67,49.84c-3.45-.6-8.15-.83-11.78-1.17-10.83-1.04-21.69-1.64-32.57-1.89-10.88.25-21.74.86-32.57,1.89-3.62.35-8.32.57-11.78,1.17-.44.08-.73.2-.98.59v30.8c10.75-.69,28.42-1.09,45.33-1.32,16.91.23,34.57.63,45.33,1.32v-30.8c-.25-.39-.54-.51-.98-.59Z"/>
      <g>
        <path class="cls-1" d="M141.33,0h46.76c25.27,0,38.72,10.99,38.72,31.01,0,14.6-8.53,22.15-16.74,25.43,12.3,3.94,20.51,14.11,20.51,28.55,0,20.67-15.26,32.81-39.54,32.81h-49.71V0ZM186.12,48.73c13.45,0,20.84-5.25,20.84-15.59s-7.38-15.42-20.84-15.42h-24.61v31.01h24.61ZM161.51,100.08h28.38c13.29,0,20.51-6.89,20.51-16.9s-7.22-16.74-20.51-16.74h-28.38v33.63Z"/>
        <path class="cls-1" d="M239.11,93.85c0-16.41,12.3-23.63,28.88-27.07l23.79-4.92v-1.48c0-8.2-4.27-13.29-14.77-13.29-9.35,0-14.27,4.27-16.57,12.63l-18.54-4.27c4.27-14.27,16.9-25.43,35.93-25.43,20.67,0,33.14,9.84,33.14,29.69v37.08c0,4.92,2.13,6.4,7.55,5.74v15.26c-14.27,1.64-21.82-1.15-24.77-8.2-5.42,6.07-14.44,9.68-25.59,9.68-16.41,0-29.04-10.01-29.04-25.43ZM291.77,76.95l-18.54,3.94c-8.37,1.8-14.6,4.43-14.6,12.14,0,6.73,4.92,10.5,12.47,10.5,10.5,0,20.67-5.58,20.67-16.08v-10.5Z"/>
        <path class="cls-1" d="M338.2,89.58c5.09,8.37,14.93,13.95,24.94,13.95,8.37,0,16.08-2.95,16.08-10.67s-7.22-8.2-20.84-10.99c-13.62-2.79-29.2-6.23-29.2-24.61,0-15.75,13.78-27.23,33.63-27.23,15.09,0,28.55,6.73,34.78,16.24l-13.29,11.98c-4.92-7.71-13.13-12.14-22.64-12.14-8.04,0-13.29,3.61-13.29,9.35,0,6.23,6.23,7.38,17.06,9.68,14.6,3.12,32.98,6.23,32.98,25.92,0,17.39-15.91,28.55-35.44,28.55-15.91,0-31.83-6.4-39.54-18.21l14.77-11.81Z"/>
        <path class="cls-1" d="M415.31,48.4h-11.98v-16.74h11.98V6.4h19.36v25.27h18.05v16.74h-18.05v44.63c0,7.71,4.43,8.53,11.49,8.53,3.28,0,5.09-.16,8.04-.49v16.57c-3.61.66-8.53,1.15-13.62,1.15-16.41,0-25.27-5.09-25.27-22.64v-47.74Z"/>
        <path class="cls-1" d="M468.63,0h20.34v20.18h-20.34V0ZM488.65,117.8h-19.69V31.66h19.69v86.14Z"/>
        <path class="cls-1" d="M545.41,119.6c-24.28,0-41.51-18.05-41.51-44.79s17.23-44.79,41.51-44.79,41.51,18.05,41.51,44.79-17.23,44.79-41.51,44.79ZM545.41,103.03c13.29,0,21.66-10.67,21.66-28.22s-8.37-28.22-21.66-28.22-21.66,10.66-21.66,28.22,8.37,28.22,21.66,28.22Z"/>
        <path class="cls-1" d="M602.18,31.66h19.69v9.19c4.92-5.74,12.63-10.83,23.79-10.83,18.05,0,28.88,12.47,28.88,31.01v56.77h-19.69v-51.02c0-10.67-4.27-18.38-15.09-18.38-8.86,0-17.88,6.56-17.88,18.87v50.53h-19.69V31.66Z"/>
      </g>
    </g>
  </g>
</svg>`;
/** Rasterise un SVG (blob local) en PNG data-URL via canvas — nécessaire pour
    que jsPDF puisse embarquer le logo (il ne lit pas les SVG). */
async function svgToPngDataUrl(svg: string, aspect: number): Promise<string | null> {
  try {
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('svg load'));
      img.src = url;
    });
    const w = 900;
    const h = Math.round(w / aspect);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas 2d context');
    ctx.drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(url);
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

/* Nettoyage des caractères hors encodage WinAnsi (les polices standards jsPDF
   ne dessinent pas les flèches, ≥, ✓…) — on les remplace sans les inventer. */
function sanitizePdfText(input: string): string {
  return String(input ?? '')
    .replace(/\*\*/g, '')
    .replace(/→/g, ' — ')
    .replace(/←/g, ' — ')
    .replace(/[⇒⇔↔↑↓]/g, ' ')
    .replace(/≥/g, '>= ')
    .replace(/≤/g, '<= ')
    .replace(/⚠️|⚠/g, '')
    .replace(/✅/g, '')
    .replace(/❌/g, '')
    .trim();
}

export interface PortfolioPdfItem {
  address: string;
  status: string;
  result?: {
    adresse?: { normalisee?: string };
    aleas?: Array<{
      code: string;
      libelle: string;
      present: boolean | null;
      resolution?: 'per-building' | 'commune-level' | 'commune-level-estimate' | null;
    }>;
    erreurs_partielles?: string[];
  } | null;
  error?: string | null;
}

export interface PortfolioPdfInput {
  items: PortfolioPdfItem[];
  histogram: Array<{ key: string; label: string; color: string; count: number }>;
  total: number;
  completed: number;
  failed: number;
}

export async function exportPortfolioPdf(input: PortfolioPdfInput): Promise<void> {
  const { items, histogram, total, completed, failed } = input;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
  const wordmark = await svgToPngDataUrl(TYPHOON_WORDMARK_SVG, 674.53 / 119.6);

  /* Paysage : largeur utile plus grande — on redéfinit les constantes. */
  const PW = 297;
  const PH = 210;
  const MM = 14;
  const CWW = PW - 2 * MM;
  const FOOTER_Y = PH - 10;
  const SAFE_Y = PH - 14;
  let y = 0;

  doc.setFillColor(NAVY);
  doc.rect(0, 0, PW, 34, 'F');
  doc.setFillColor(NAVY_LIGHT);
  doc.rect(0, 0, PW, 2.4, 'F');
  doc.setFillColor(ACCENT);
  doc.rect(0, 34, PW, 1.8, 'F');
  if (wordmark) {
    doc.addImage(wordmark, 'PNG', MM, 10, 42, 42 / (674.53 / 119.6));
  } else {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(20);
    doc.setTextColor('#FFFFFF');
    doc.text('TYPHOON', MM, 16);
  }
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor('#FFFFFF');
  doc.text('Synthèse de portefeuille — souscription', PW - MM, 13, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(WHITE_60);
  doc.text('Diagnostic géo-risque par bâtiment · faits + provenance', PW - MM, 18.5, { align: 'right' });
  doc.text(`Généré le ${new Date().toISOString().slice(0, 10)}`, PW - MM, 23, { align: 'right' });

  y = 44;

  /* ── Chiffres clés ── */
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12.5);
  doc.setTextColor(NAVY);
  doc.text('Chiffres clés', MM, y);
  y += 5;
  const review = items.filter((it) => {
    const aleas = it.result?.aleas ?? [];
    return (
      aleas.length > 0 &&
      aleas.every((a) => a.resolution !== 'per-building') &&
      aleas.some((a) => a.resolution === 'commune-level-estimate')
    );
  }).length;
  const stats: Array<[string, number | string, string]> = [
    ['Adresses', total, NAVY],
    ['Terminées', completed, OK],
    ['En erreur', failed, MUTED],
    ['À expertiser', review, WARN_INK],
  ];
  const colW = CWW / stats.length;
  stats.forEach(([label, value, color], i) => {
    const x = MM + i * colW;
    doc.setFillColor(TINT);
    doc.roundedRect(x, y - 5, colW - 8, 22, 2, 2, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.setTextColor(color);
    doc.text(String(value), x + 5, y + 4);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(MUTED);
    doc.text(label, x + 5, y + 11);
  });
  y += 28;

  /* ── Histogramme des bandes ── */
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11.5);
  doc.setTextColor(NAVY);
  doc.text('Répartition par bande D03', MM, y);
  y += 6;
  const maxCount = Math.max(1, ...histogram.map((h) => h.count));
  const barArea = 30;
  const barW = (CWW - (histogram.length - 1) * 8) / Math.max(1, histogram.length);
  histogram.forEach((h, i) => {
    const x = MM + i * (barW + 8);
    const hPx = Math.max(2, (h.count / maxCount) * barArea);
    doc.setFillColor(h.color);
    doc.rect(x, y + barArea - hPx, barW, hPx, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(INK);
    doc.text(String(h.count), x + barW / 2, y + barArea - hPx - 1.5, { align: 'center' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(MUTED);
    doc.text(h.label, x + barW / 2, y + barArea + 4, { align: 'center' });
  });
  y += barArea + 12;

  /* ── Tableau des adresses ── */
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11.5);
  doc.setTextColor(NAVY);
  doc.text('Détail par adresse', MM, y);
  y += 5;
  const rowH = 6.4;
  const drawHeader = () => {
    doc.setFillColor(NAVY);
    doc.rect(MM, y, CWW, 6, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor('#FFFFFF');
    const cols: Array<[string, number]> = [
      ['Adresse', CWW * 0.5],
      ['Score', CWW * 0.12],
      ['Bande', CWW * 0.16],
      ['Statut', CWW * 0.22],
    ];
    let cx = MM;
    cols.forEach(([label, w]) => {
      doc.text(label, cx + 2, y + 4);
      cx += w;
    });
    y += 6;
  };
  drawHeader();

  items.forEach((it, i) => {
    if (y + rowH > SAFE_Y) {
      doc.addPage();
      y = 16;
      drawHeader();
    }
    if (i % 2 === 1) {
      doc.setFillColor(ROW_ALT);
      doc.rect(MM, y, CWW, rowH, 'F');
    }
    const aleasIt = it.result?.aleas ?? [];
    const hasPerBuilding = aleasIt.some((a) => a.resolution === 'per-building');
    const band = bandForResolution(
      hasPerBuilding ? 'per-building' : aleasIt[0]?.resolution ?? null
    );
    const statusLabel = it.status === 'completed' ? 'OK' : it.status === 'failed' ? 'Erreur' : it.status;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(INK);
    doc.text(doc.splitTextToSize(sanitizePdfText(it.result?.adresse?.normalisee ?? it.address), CWW * 0.5 - 6)[0], MM + 2, y + 4.2);
    const nbB = aleasIt.filter((a) => a.resolution === 'per-building').length;
    doc.text(String(nbB), MM + CWW * 0.5 + 2, y + 4.2);
    doc.setTextColor(band?.color ?? MUTED);
    doc.text(band?.label ?? '—', MM + CWW * 0.62 + 2, y + 4.2);
    doc.setTextColor(it.status === 'failed' ? WARN_INK : MUTED);
    doc.text(statusLabel, MM + CWW * 0.78 + 2, y + 4.2);
    y += rowH;
  });

  /* ── Pied de page ── */
  const totalPages = doc.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    doc.setDrawColor(LINE);
    doc.setLineWidth(0.3);
    doc.line(MM, FOOTER_Y, PW - MM, FOOTER_Y);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(MUTED);
    doc.text('Généré par Typhon · Sources : Géorisques (BRGM/MTE), BDNB, Open-Meteo, Copernicus CDS', MM, FOOTER_Y + 4);
    doc.text(`Page ${i} / ${totalPages}`, PW - MM, FOOTER_Y + 4, { align: 'right' });
  }

  doc.save(`portfolio_typhoon_${new Date().toISOString().slice(0, 10)}.pdf`);
}
