// Lecture de fichiers CSV / TSV (export Google Sheets, copier-coller d'un tableur).

/** Devine le séparateur à partir de la première ligne non vide. */
export function detecterSeparateur(texte) {
  const premiere = String(texte).split(/\r?\n/).find((l) => l.trim()) || '';
  const candidats = ['\t', ';', ','];
  let meilleur = ',';
  let max = 0;
  for (const sep of candidats) {
    const n = compterHorsGuillemets(premiere, sep);
    if (n > max) {
      max = n;
      meilleur = sep;
    }
  }
  return meilleur;
}

function compterHorsGuillemets(ligne, sep) {
  let n = 0;
  let dansGuillemets = false;
  for (const c of ligne) {
    if (c === '"') dansGuillemets = !dansGuillemets;
    else if (c === sep && !dansGuillemets) n++;
  }
  return n;
}

/** Analyse un texte CSV/TSV en tableau de lignes (tableaux de cellules). */
export function parserCsv(texte, separateur = detecterSeparateur(texte)) {
  const s = String(texte).replace(/^﻿/, '');
  const lignes = [];
  let ligne = [];
  let cellule = '';
  let dansGuillemets = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (dansGuillemets) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cellule += '"';
          i++;
        } else dansGuillemets = false;
      } else cellule += c;
      continue;
    }
    if (c === '"' && cellule === '') dansGuillemets = true;
    else if (c === separateur) {
      ligne.push(cellule);
      cellule = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      ligne.push(cellule);
      lignes.push(ligne);
      ligne = [];
      cellule = '';
    } else cellule += c;
  }
  if (cellule !== '' || ligne.length) {
    ligne.push(cellule);
    lignes.push(ligne);
  }
  return lignes.filter((l) => l.some((c) => String(c).trim() !== ''));
}

/** Retourne { entetes, lignes } où chaque ligne est un tableau aligné sur les en-têtes. */
export function lireTableau(texte) {
  const brut = parserCsv(texte);
  if (!brut.length) return { entetes: [], lignes: [] };
  const entetes = brut[0].map((h, i) => String(h).trim() || `Colonne ${i + 1}`);
  const lignes = brut.slice(1).map((l) => entetes.map((_, i) => String(l[i] ?? '').trim()));
  return { entetes, lignes };
}
