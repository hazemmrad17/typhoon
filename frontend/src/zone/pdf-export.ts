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
import {
  D03,
  bandForKey,
  aleaScore,
  type AleaDetail,
  type RisqueReport,
  type RapportNarratif,
  type Trajectoire,
} from './config';

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

export async function exportRapportPdf(report: RisqueReport, rapport: RapportNarratif): Promise<void> {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
  const wordmark = await svgToPngDataUrl(TYPHOON_WORDMARK_SVG, 674.53 / 119.6);

  let y = 0;

  /* ── Helpers de mise en page (mutent `y` partagé) ── */
  const ensureSpace = (h: number) => {
    if (y + h > SAFE_BOTTOM) {
      doc.addPage();
      y = 18;
    }
  };

  /** Titre de section : barre accent à gauche + texte navy. */
  const sectionTitle = (title: string) => {
    ensureSpace(10);
    doc.setFillColor(ACCENT);
    doc.rect(M, y - 3.4, 1.7, 5.6, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12.5);
    doc.setTextColor(NAVY);
    doc.text(title, M + 4.6, y);
    y += 5.6;
  };

  /** Paragraphe justifié à gauche, avec passage à la page automatique. */
  const paragraph = (text: string, size = 10, lineH = 4.9, color = INK, style: 'normal' | 'italic' = 'normal') => {
    doc.setFont('helvetica', style);
    doc.setFontSize(size);
    doc.setTextColor(color);
    const lines = doc.splitTextToSize(sanitizePdfText(text), CW);
    for (const ln of lines) {
      if (y > SAFE_BOTTOM) {
        doc.addPage();
        y = 18;
      }
      doc.text(ln, M, y);
      y += lineH;
    }
  };

  const divider = () => {
    doc.setDrawColor(LINE);
    doc.setLineWidth(0.35);
    doc.line(M, y, PAGE_W - M, y);
    y += 7;
  };

  /* ══ Bande d'en-tête de marque ══ */
  doc.setFillColor(NAVY);
  doc.rect(0, 0, PAGE_W, 46, 'F');
  doc.setFillColor(NAVY_LIGHT);
  doc.rect(0, 0, PAGE_W, 3, 'F');
  doc.setFillColor(ACCENT);
  doc.rect(0, 46, PAGE_W, 2.2, 'F');

  if (wordmark) {
    doc.addImage(wordmark, 'PNG', M, 15, 52, 52 / (674.53 / 119.6));
  } else {
    /* Repli : si la rasterisation du SVG a échoué, la marque reste présente. */
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(24);
    doc.setTextColor('#FFFFFF');
    doc.text('TYPHOON', M, 23);
  }
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor('#FFFFFF');
  doc.text('Rapport d’analyse IA', PAGE_W - M, 17, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(WHITE_60);
  doc.text('Diagnostic géo-risque · Résilience climatique du bâtiment', PAGE_W - M, 23, { align: 'right' });

  y = 56;

  /* ══ Métadonnées d'adresse ══ */
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15.5);
  doc.setTextColor(NAVY);
  const adresseLines = doc.splitTextToSize(sanitizePdfText(report.adresse_normalisee || report.adresse_saisie), CW);
  doc.text(adresseLines, M, y);
  y += adresseLines.length * 6.4;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(MUTED);
  doc.text(
    `Code INSEE ${report.code_insee} · GPS ${report.lat.toFixed(5)}°N, ${report.lon.toFixed(5)}°E · ${report.alea_count} aléa(s) recensé(s) · Données Géorisques (BRGM/MTE)`,
    M,
    y
  );
  y += 4.6;
  doc.text(`Rapport généré par Typhon le ${report.date_generation} — analyse IA (Mistral)`, M, y);
  y += 4;
  divider();

  /* ══ Score de risque global (jauge D03) ══ */
  const presentAleas = (report.aleas || []).filter((a) => a.present === true);
  const maxScore = presentAleas.length ? Math.max(...presentAleas.map((a) => aleaScore(a))) : null;
  const globalBand = maxScore != null ? D03.find((b) => maxScore < b.max) || D03[D03.length - 1] : null;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11.5);
  doc.setTextColor(NAVY);
  doc.text('Score de risque global', M, y);
  y += 3;

  const gap = 0.9;
  const segW = (CW - 4 * gap) / 5;
  const gy = y;
  D03.forEach((b, i) => {
    doc.setFillColor(b.color);
    doc.rect(M + i * (segW + gap), gy, segW, 4.6, 'F');
  });
  if (maxScore != null) {
    const pct = Math.min(1, maxScore / 100);
    doc.setFillColor('#FFFFFF');
    doc.circle(M + CW * pct, gy + 2.3, 2.6, 'F');
    doc.setFillColor(INK);
    doc.circle(M + CW * pct, gy + 2.3, 1.7, 'F');
  }
  y += 8;

  if (maxScore != null && globalBand) {
    const label = `${maxScore}/100 · ${globalBand.label}`;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    const tw = doc.getTextWidth(label) + 8;
    doc.setFillColor(globalBand.color);
    doc.roundedRect(M, y - 3.4, tw, 6.4, 3.2, 3.2, 'F');
    doc.setTextColor('#FFFFFF');
    doc.text(label, M + 4, y + 0.5);
    y += 10;
  } else {
    y += 3;
  }

  /* ══ Tableau des aléas recensés ══ */
  const rows = (report.aleas || []).filter((a) => a.present !== false);
  if (rows.length) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(NAVY);
    doc.text('Aléas recensés — Géorisques', M, y);
    y += 4.6;

    const xB = M + 88;
    const xC = M + 116;
    const xD = PAGE_W - M;
    const rowH = 6.6;

    /* En-tête du tableau (redessiné après chaque saut de page). */
    const drawTableHeader = () => {
      doc.setFillColor(NAVY);
      doc.rect(M, y, CW, 6.4, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor('#FFFFFF');
      doc.text('Aléa', M + 1.5, y + 4.4);
      doc.text('Statut', xB + 1.5, y + 4.4);
      doc.text('Niveau', xC + 1.5, y + 4.4);
      doc.text('Score /100', xD, y + 4.4, { align: 'right' });
      y += 6.4;
    };
    drawTableHeader();

    const shown = rows.slice(0, 14);
    shown.forEach((a, i) => {
      if (y + rowH > SAFE_BOTTOM) {
        doc.addPage();
        y = 18;
        drawTableHeader();
      }
      if (i % 2 === 1) {
        doc.setFillColor(ROW_ALT);
        doc.rect(M, y, CW, rowH, 'F');
      }
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(INK);
      const name = doc.splitTextToSize(sanitizePdfText(a.libelle), 84)[0];
      doc.text(name, M + 1.5, y + 4.3);

      let status: string;
      let statusColor: string;
      if (a.present === true) {
        status = 'Concerné';
        statusColor = OK;
      } else if (a.present === false) {
        status = 'Non concerné';
        statusColor = MUTED;
      } else {
        status = 'Source indisponible';
        statusColor = MUTED;
      }
      doc.setTextColor(statusColor);
      doc.text(status, xB + 1.5, y + 4.3);

      const b = bandForKey(a.niveau);
      if (a.present === true) {
        if (b) {
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(8.5);
          const tw = doc.getTextWidth(b.label) + 4.5;
          doc.setFillColor(b.color);
          doc.roundedRect(xC + 1, y + 1.6, tw, 5.2, 2.6, 2.6, 'F');
          doc.setTextColor('#FFFFFF');
          doc.text(b.label, xC + 3.2, y + 4.8);
        } else {
          doc.setFont('helvetica', 'normal');
          doc.setTextColor(MUTED);
          doc.text('—', xC + 1.5, y + 4.3);
        }
      } else {
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(MUTED);
        doc.text('—', xC + 1.5, y + 4.3);
      }

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(INK);
      doc.text(a.present === true ? String(aleaScore(a)) : '—', xD, y + 4.3, { align: 'right' });
      y += rowH;
    });

    if (rows.length > 14) {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(8.5);
      doc.setTextColor(MUTED);
      doc.text(`+ ${rows.length - 14} autre(s) aléa(s) — détail complet sur Géorisques`, M, y + 3.5);
      y += 8;
    } else {
      y += 2;
    }
    divider();
  }

  /* ══ Fiche du bien (BDNB) ══ */
  const batiment = report.bdnb?.batiment;
  if (batiment) {
    const fields: Array<[string, string]> = (
      [
        ['Année de construction', batiment.annee_construction != null ? String(batiment.annee_construction) : null],
        ['Murs', batiment.mat_mur_txt],
        ['Toiture', batiment.mat_toit_txt],
        ['Niveaux', batiment.nb_niveau != null ? String(batiment.nb_niveau) : null],
        ['Hauteur', batiment.hauteur_mean != null ? `${batiment.hauteur_mean} m` : null],
        ['Surface au sol', batiment.surface_emprise_sol != null ? `${batiment.surface_emprise_sol} m²` : null],
        ['Usage', batiment.usage_niveau_1_txt],
        ['Aléa argile (BDNB)', batiment.alea_argile],
      ] as Array<[string, string | null]>
    ).filter(([, v]) => v != null && v.trim() !== '') as Array<[string, string]>;

    if (fields.length) {
      sectionTitle('Fiche du bien — BDNB');
      const line = fields.map(([l, v]) => `${l} : ${v}`).join('   ·   ');
      paragraph(line);
      y += 1;
      divider();
    }
  }

  /* ══ Sections du rapport IA ══ */
  if (rapport.introduction) {
    sectionTitle('Introduction');
    paragraph(rapport.introduction);
    y += 2;
  }

  (rapport.sections || []).forEach((s) => {
    if (!s.contenu) return;
    sectionTitle(s.titre || 'Analyse');
    paragraph(s.contenu);
    y += 2;
  });

  /* ══ Synthèse finale (encadrée) ══ */
  if (rapport.synthese_finale) {
    const synLines = doc.splitTextToSize(sanitizePdfText(rapport.synthese_finale), CW - 14);
    const boxH = synLines.length * 4.9 + 17;
    ensureSpace(boxH);
    doc.setFillColor(TINT);
    doc.roundedRect(M, y - 1, CW, boxH, 2.5, 2.5, 'F');
    doc.setFillColor(ACCENT);
    doc.rect(M, y - 1, 2.2, boxH, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(ACCENT);
    doc.text('Synthèse finale', M + 6, y + 5);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(INK);
    let ty = y + 11;
    for (const ln of synLines) {
      doc.text(ln, M + 6, ty);
      ty += 4.9;
    }
    y += boxH + 8;
  }

  /* ══ Obligations réglementaires ══ */
  const obligations = (rapport.obligations_reglementaires || []).filter((o) => o && o.trim());
  if (obligations.length) {
    sectionTitle('Obligations réglementaires');
    obligations.forEach((o) => {
      const lines = doc.splitTextToSize(sanitizePdfText(o), CW - 6);
      const h = lines.length * 4.8 + 2;
      ensureSpace(h);
      doc.setFillColor(ACCENT);
      doc.circle(M + 1.4, y - 1.8, 0.9, 'F');
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      doc.setTextColor(INK);
      let ly = y;
      for (const ln of lines) {
        doc.text(ln, M + 5, ly);
        ly += 4.8;
      }
      y = ly + 1.5;
    });
    y += 2;
  }

  /* ══ Avertissement ══ */
  const avert = rapport.avertissement_ia;
  if (avert) {
    const warnLines = doc.splitTextToSize(sanitizePdfText(avert), CW - 8);
    const boxH = warnLines.length * 3.8 + 11;
    ensureSpace(boxH);
    doc.setFillColor(WARN_TINT);
    doc.roundedRect(M, y - 1, CW, boxH, 2, 2, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(WARN_INK);
    doc.text('Avertissement', M + 4, y + 3.6);
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8);
    doc.setTextColor(MUTED);
    let wy = y + 7;
    for (const ln of warnLines) {
      doc.text(ln, M + 4, wy);
      wy += 3.8;
    }
    y = wy + 5;
  }

  /* ══ Pied de page (toutes pages) ══ */
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setDrawColor(LINE);
    doc.setLineWidth(0.3);
    doc.line(M, FOOTER_TOP, PAGE_W - M, FOOTER_TOP);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(MUTED);
    doc.text('Généré par Typhon · Sources : Géorisques (BRGM/MTE), BDNB, Mistral', M, FOOTER_TOP + 5);
    doc.text(`Page ${i} / ${total}`, PAGE_W - M, FOOTER_TOP + 5, { align: 'right' });
  }

  const datePart = (report.date_generation || '').slice(0, 10);
  doc.save(`rapport_typhoon_${report.code_insee || 'adresse'}_${datePart}.pdf`);
}

// =============================================================================
//   Export PDF assurance (Ticket 2 — insurerpagesplan)
//   Même système visuel que le rapport générique (bande de marque, palette,
//   pied paginé), plus :
//     · tableau de trajectoire décomposé par horizon (2026 / 2050 / 2100),
//       valeurs brutes F par péril (mêmes données que la carte de décision)
//     · champs organisation / référence (saisis sur l'étape Rapport)
//     · disclaimer « ne remplace pas l'ERRIAL officiel » (texte bloquant :
//       à faire valider par conformité avant usage client réel)
// =============================================================================

export interface InsurerPdfInput {
  report: RisqueReport;
  trajectoire: Trajectoire | null;
  aleas: AleaDetail[];
  /** Nom de l'organisation (assureur) — saisi sur l'étape Rapport. */
  organisation?: string;
  /** Référence du dossier souscription. */
  reference?: string;
}

const DISCLAIMER = (
  'Ce document est généré automatiquement par Typhon à partir de données ' +
  'publiques (Géorisques/BRGM, BDNB, Open-Meteo, Copernicus CDS). Il ne ' +
  'remplace pas l\u2019ERRIAL officiel ni l\u2019avis d\u2019un expert en ' +
  'assurance — à faire valider par la conformité avant usage en souscription.'
);

/** Verdict de souscription — même règle que DecisionCard. */
function insurerVerdict(band: { label: string; key: string } | null): string {
  if (!band) return 'À expertiser';
  if (band.key === 'critique') return 'Refus possible';
  if (band.key === 'eleve') return 'À expertiser';
  return 'Acceptable';
}

export async function exportInsurerPdf(input: InsurerPdfInput): Promise<void> {
  const { report, trajectoire, aleas, organisation, reference } = input;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
  const wordmark = await svgToPngDataUrl(TYPHOON_WORDMARK_SVG, 674.53 / 119.6);

  let y = 0;
  const ensureSpace = (h: number) => {
    if (y + h > SAFE_BOTTOM) {
      doc.addPage();
      y = 18;
    }
  };
  const sectionTitle = (title: string) => {
    ensureSpace(10);
    doc.setFillColor(ACCENT);
    doc.rect(M, y - 3.4, 1.7, 5.6, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12.5);
    doc.setTextColor(NAVY);
    doc.text(title, M + 4.6, y);
    y += 5.6;
  };
  const paragraph = (text: string, size = 10, lineH = 4.9, color = INK) => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(size);
    doc.setTextColor(color);
    const lines = doc.splitTextToSize(sanitizePdfText(text), CW);
    for (const ln of lines) {
      if (y > SAFE_BOTTOM) {
        doc.addPage();
        y = 18;
      }
      doc.text(ln, M, y);
      y += lineH;
    }
  };

  /* ══ Bande d'en-tête de marque ══ */
  doc.setFillColor(NAVY);
  doc.rect(0, 0, PAGE_W, 46, 'F');
  doc.setFillColor(NAVY_LIGHT);
  doc.rect(0, 0, PAGE_W, 3, 'F');
  doc.setFillColor(ACCENT);
  doc.rect(0, 46, PAGE_W, 2.2, 'F');
  if (wordmark) {
    doc.addImage(wordmark, 'PNG', M, 15, 52, 52 / (674.53 / 119.6));
  } else {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(24);
    doc.setTextColor('#FFFFFF');
    doc.text('TYPHOON', M, 23);
  }
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor('#FFFFFF');
  doc.text('Fiche de décision souscription', PAGE_W - M, 17, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(WHITE_60);
  doc.text('Diagnostic géo-risque · Trajectoire climatique du bâtiment', PAGE_W - M, 23, { align: 'right' });

  y = 56;

  /* ══ Métadonnées d'adresse + organisation / référence ══ */
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15.5);
  doc.setTextColor(NAVY);
  const adresseLines = doc.splitTextToSize(sanitizePdfText(report.adresse_normalisee || report.adresse_saisie), CW);
  doc.text(adresseLines, M, y);
  y += adresseLines.length * 6.4;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(MUTED);
  doc.text(
    `Code INSEE ${report.code_insee} · GPS ${report.lat.toFixed(5)}°N, ${report.lon.toFixed(5)}°E · ${report.alea_count} aléa(s) recensé(s)`,
    M,
    y
  );
  y += 4.6;

  if (organisation || reference) {
    doc.text(
      `Organisation : ${sanitizePdfText(organisation || '—')} · Référence : ${sanitizePdfText(reference || '—')}`,
      M,
      y
    );
    y += 4.6;
  }
  doc.text(`Généré par Typhon le ${report.date_generation}`, M, y);
  y += 4;
  doc.setDrawColor(LINE);
  doc.setLineWidth(0.35);
  doc.line(M, y, PAGE_W - M, y);
  y += 7;

  /* ══ Verdict + score ══ */
  const presentAleas = (aleas || []).filter((a) => a.present === true);
  const maxScore = presentAleas.length ? Math.max(...presentAleas.map((a) => aleaScore(a))) : null;
  const globalBand = maxScore != null ? D03.find((b) => maxScore < b.max) || D03[D03.length - 1] : null;

  sectionTitle('Verdict de souscription');
  const verdictText = `${insurerVerdict(globalBand)} — score ${maxScore ?? '—'}/100${globalBand ? ` (${globalBand.label})` : ''}`;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(globalBand?.color ?? NAVY);
  doc.text(sanitizePdfText(verdictText), M, y);
  y += 8;

  /* ══ Tableau de trajectoire : péril × horizon (valeurs brutes F) ══ */
  const perils = trajectoire?.perils ?? {};
  const perilEntries = Object.entries(perils);
  if (perilEntries.length) {
    sectionTitle('Trajectoire climatique — décomposition par péril');
    const horizons = [2026, 2050, 2100];
    const rowH = 7;
    const x1 = M;
    const x2 = M + 62;
    const colW = (CW - 62) / horizons.length;

    const drawHeader = () => {
      doc.setFillColor(NAVY);
      doc.rect(M, y, CW, 6.6, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor('#FFFFFF');
      doc.text('Péril', x1 + 1.5, y + 4.6);
      horizons.forEach((h, i) => {
        doc.text(String(h), x2 + i * colW + colW / 2, y + 4.6, { align: 'center' });
      });
      y += 6.6;
    };
    drawHeader();

    perilEntries.forEach(([, p], idx) => {
      if (y + rowH > SAFE_BOTTOM) {
        doc.addPage();
        y = 18;
        drawHeader();
      }
      if (idx % 2 === 1) {
        doc.setFillColor(ROW_ALT);
        doc.rect(M, y, CW, rowH, 'F');
      }
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(INK);
      doc.text(doc.splitTextToSize(sanitizePdfText(p.label), 58)[0], x1 + 1.5, y + 4.6);
      horizons.forEach((h, i) => {
        const pt = p.points.find((x) => x.horizon === h);
        const val = pt && pt.type !== 'indisponible' ? pt.valeur : null;
        const cell = val != null ? String(val) : '—';
        doc.setFont('helvetica', val != null ? 'bold' : 'normal');
        doc.setTextColor(val != null ? NAVY : MUTED);
        doc.text(cell, x2 + i * colW + colW / 2, y + 4.6, { align: 'center' });
      });
      y += rowH;
    });
    y += 5;

    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8);
    doc.setTextColor(MUTED);
    doc.text(
      'Valeurs brutes F (0-100) par variable d\u2019aléa — 2026 observé, 2050 projeté (Open-Meteo), 2100 projeté (Copernicus CDS, scénario RCP). Jamais combinées entre périls.',
      M,
      y
    );
    y += 8;
  }

  /* ══ Aléas présents (rappel compact) ══ */
  if (presentAleas.length) {
    sectionTitle('Aléas recensés');
    const line = presentAleas
      .map((a) => {
        const b = bandForKey(a.niveau);
        return `${a.libelle}${b ? ` (${b.label})` : ''}`;
      })
      .join('   ·   ');
    paragraph(line);
    y += 2;
  }

  /* ══ Disclaimer (texte bloquant — à valider conformité) ══ */
  const warnLines = doc.splitTextToSize(DISCLAIMER, CW - 8);
  const boxH = warnLines.length * 3.8 + 11;
  ensureSpace(boxH);
  doc.setFillColor(WARN_TINT);
  doc.roundedRect(M, y - 1, CW, boxH, 2, 2, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(WARN_INK);
  doc.text('Avertissement', M + 4, y + 3.6);
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(8);
  doc.setTextColor(MUTED);
  let wy = y + 7;
  for (const ln of warnLines) {
    doc.text(ln, M + 4, wy);
    wy += 3.8;
  }
  y = wy + 5;

  /* ══ Pied de page ══ */
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setDrawColor(LINE);
    doc.setLineWidth(0.3);
    doc.line(M, FOOTER_TOP, PAGE_W - M, FOOTER_TOP);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(MUTED);
    doc.text('Généré par Typhon · Sources : Géorisques (BRGM/MTE), BDNB, Open-Meteo, Copernicus CDS', M, FOOTER_TOP + 5);
    doc.text(`Page ${i} / ${total}`, PAGE_W - M, FOOTER_TOP + 5, { align: 'right' });
  }

  const datePart = (report.date_generation || '').slice(0, 10);
  doc.save(`decision_souscription_${report.code_insee || 'adresse'}_${datePart}.pdf`);
}

// =============================================================================
//   Export PDF de synthèse Portfolio (Ticket 4 — insurerpagesplan)
//   Résumé du livre : total, terminées, en erreur, à expertiser + tableau des
//   adresses par bande D03. Réutilise la bande de marque et le pied paginé.
// =============================================================================

export interface PortfolioPdfInput {
  items: Array<{
    address: string;
    status: string;
    result: {
      adresse?: { label?: string };
      score_global?: number | null;
      niveau_global?: string | null;
    } | null;
    error?: string | null;
  }>;
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
  doc.text('Diagnostic géo-risque en lot · Trajectoire climatique', PW - MM, 18.5, { align: 'right' });
  doc.text(`Généré le ${new Date().toISOString().slice(0, 10)}`, PW - MM, 23, { align: 'right' });

  y = 44;

  /* ── Chiffres clés ── */
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12.5);
  doc.setTextColor(NAVY);
  doc.text('Chiffres clés', MM, y);
  y += 5;
  const review = items.filter((it) => {
    const k = it.result?.niveau_global;
    return k === 'eleve' || k === 'critique';
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
    const band = bandForKey(it.result?.niveau_global);
    const statusLabel = it.status === 'completed' ? 'OK' : it.status === 'failed' ? 'Erreur' : it.status;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(INK);
    doc.text(doc.splitTextToSize(sanitizePdfText(it.result?.adresse?.label ?? it.address), CWW * 0.5 - 6)[0], MM + 2, y + 4.2);
    doc.text(it.result?.score_global != null ? String(it.result.score_global) : '—', MM + CWW * 0.5 + 2, y + 4.2);
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
