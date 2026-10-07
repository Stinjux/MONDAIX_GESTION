// Lecture des emails (.eml / RFC 822) et extraction des références utiles.
// Aucune connexion à une boîte n'est nécessaire : les messages peuvent être
// importés en fichier .eml, collés, saisis à la main ou reçus par webhook.

import { extraireAsins, parserMontant } from './parse.js';

function decoderOctets(octets, charset) {
  const cs = String(charset || 'utf-8').toLowerCase();
  try {
    return new TextDecoder(cs === 'us-ascii' ? 'utf-8' : cs).decode(octets);
  } catch {
    return new TextDecoder('utf-8').decode(octets);
  }
}

function octetsBinaires(s) {
  return Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
}

function decoderQuotedPrintable(s, charset) {
  const binaire = s
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return decoderOctets(octetsBinaires(binaire), charset);
}

function decoderBase64(s, charset) {
  return decoderOctets(Buffer.from(s.replace(/\s/g, ''), 'base64'), charset);
}

/** Décode les en-têtes encodés (=?UTF-8?B?...?= / =?UTF-8?Q?...?=). */
export function decoderEnteteMime(valeur) {
  return String(valeur ?? '')
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, enc, texte) => {
      if (enc.toUpperCase() === 'B') return decoderBase64(texte, charset);
      return decoderQuotedPrintable(texte.replace(/_/g, ' '), charset);
    });
}

function separerEntetes(brut) {
  const idx = brut.search(/\r?\n\r?\n/);
  const blocEntetes = idx >= 0 ? brut.slice(0, idx) : brut;
  const corps = idx >= 0 ? brut.slice(idx).replace(/^\r?\n\r?\n/, '') : '';
  const entetes = {};
  const deplie = blocEntetes.replace(/\r?\n[ \t]+/g, ' ');
  for (const ligne of deplie.split(/\r?\n/)) {
    const m = ligne.match(/^([\w-]+):\s*(.*)$/);
    if (m) {
      const cle = m[1].toLowerCase();
      if (!(cle in entetes)) entetes[cle] = m[2];
    }
  }
  return { entetes, corps };
}

function parametre(entete, nom) {
  const m = String(entete || '').match(new RegExp(`${nom}\\s*=\\s*"?([^";]+)"?`, 'i'));
  return m ? m[1] : null;
}

function htmlVersTexte(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function extrairePartiesTexte(entetes, corps) {
  const type = entetes['content-type'] || 'text/plain';
  const encodage = (entetes['content-transfer-encoding'] || '').toLowerCase();
  if (/^multipart\//i.test(type)) {
    const frontiere = parametre(type, 'boundary');
    if (!frontiere) return [];
    const morceaux = corps.split(new RegExp(`\\r?\\n?--${frontiere.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?\\s*`));
    return morceaux.flatMap((morceau) => {
      if (!morceau.trim()) return [];
      const partie = separerEntetes(morceau);
      if (!Object.keys(partie.entetes).length) return [];
      return extrairePartiesTexte(partie.entetes, partie.corps);
    });
  }
  if (!/^text\/(plain|html)/i.test(type)) return [];
  const charset = parametre(type, 'charset');
  let texte = corps;
  if (encodage === 'base64') texte = decoderBase64(corps, charset);
  else if (encodage === 'quoted-printable') texte = decoderQuotedPrintable(corps, charset);
  else if (charset && !/utf-?8|us-ascii/i.test(charset)) texte = decoderOctets(octetsBinaires(corps), charset);
  return [{ html: /html/i.test(type), texte }];
}

/** Analyse un email brut (.eml) → { messageId, expediteur, sujet, date, corps }. */
export function parserEml(brut) {
  const { entetes, corps } = separerEntetes(String(brut));
  const parties = extrairePartiesTexte(entetes, corps);
  const texte = parties.find((p) => !p.html);
  const html = parties.find((p) => p.html);
  let corpsTexte = texte ? texte.texte : html ? htmlVersTexte(html.texte) : corps;
  corpsTexte = corpsTexte.replace(/\r\n/g, '\n').trim();
  let date = null;
  if (entetes.date) {
    const d = new Date(entetes.date);
    if (!Number.isNaN(d.getTime())) date = d.toISOString();
  }
  return {
    messageId: (entetes['message-id'] || '').replace(/[<>]/g, '').trim() || null,
    expediteur: decoderEnteteMime(entetes.from || ''),
    sujet: decoderEnteteMime(entetes.subject || ''),
    date,
    corps: corpsTexte,
  };
}

/** Domaine de l'adresse d'expédition (« Walmart <noreply@walmart.ca> » → « walmart.ca »). */
export function domaineExpediteur(expediteur) {
  const m = String(expediteur || '').match(/@([\w.-]+\.[a-z]{2,})/i);
  if (!m) return null;
  return m[1].toLowerCase().replace(/^(mail|email|e|info|noreply|no-reply|orders?|commandes?|news)\./, '');
}

const RE_NUMERO_COMMANDE = [
  /(?:num[ée]ro|n[°ºo]\.?|no\.?)\s*(?:de\s+)?commande\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,})/gi,
  /commande\s*(?:n[°ºo]\.?|no\.?|#|num[ée]ro)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,})/gi,
  /order\s*(?:number|no\.?|n[°ºo]|id|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,})/gi,
  /(?:commande|order)\s*#\s*([A-Z0-9][A-Z0-9-]{3,})/gi,
];

/** Numéros de commande candidats trouvés dans le sujet et le corps. */
export function extraireNumerosCommande(texte) {
  const trouves = new Set();
  for (const re of RE_NUMERO_COMMANDE) {
    for (const m of String(texte || '').matchAll(re)) {
      if (/\d/.test(m[1])) trouves.add(m[1].replace(/-+$/, ''));
    }
  }
  return [...trouves];
}

/** Montant total annoncé dans une confirmation de commande. */
export function extraireMontantTotal(texte) {
  const re = /(?:total\s*(?:de\s+la\s+commande|commande|ttc|g[ée]n[ée]ral|order\s+total|final)?|grand\s+total|montant\s+total|order\s+total)\s*[:\-]?\s*(?:CAD|CA\$|\$|C\$)?\s*([\d][\d\s.,]*\d|\d)/gi;
  let dernier = null;
  for (const m of String(texte || '').matchAll(re)) {
    const v = parserMontant(m[1]);
    if (v !== null) dernier = v; // le dernier « total » est en général le total final
  }
  return dernier;
}

/** Numéro de cas Amazon (Seller Central) : identifiant numérique de 8 à 12 chiffres. */
export function extraireNumerosCas(texte) {
  const re = /(?:case|cas|dossier|requ[êe]te|ticket)\s*(?:id|n[°ºo]\.?|no\.?|number|num[ée]ro|#)?\s*(?:de\s+cas\s*)?[:#]?\s*(\d{8,12})\b/gi;
  const trouves = new Set();
  for (const m of String(texte || '').matchAll(re)) trouves.add(m[1]);
  return [...trouves];
}

/**
 * Statut détecté dans une réponse d'Amazon à une demande d'autorisation.
 * Les refus sont testés avant les approbations (« not approved » contient « approved »).
 */
export function detecterStatutAutorisation(texte) {
  const t = String(texte || '').toLowerCase();
  if (/(not been approved|not approved|denied|rejected|declined|unable to approve|refus[ée]e?|rejet[ée]e?|n'a pas [ée]t[ée] approuv|ne pouvons pas approuver)/.test(t)) return 'refuse';
  if (/(additional information|more information|please provide|documents? requis|informations? suppl[ée]mentaires?|veuillez fournir|pi[èe]ces? justificatives?)/.test(t)) return 'documents_requis';
  if (/(has been approved|have been approved|approved to sell|you can now (sell|list)|now eligible|approuv[ée]e?|vous pouvez maintenant (vendre|lister)|autoris[ée]e? [àa] vendre)/.test(t)) return 'approuve';
  return null;
}

/** Extraction complète selon le module destinataire de la source email. */
export function extraireReferences(module, message) {
  const texte = `${message.sujet || ''}\n${message.corps || ''}`;
  if (module === 'commandes') {
    return {
      numerosCommande: extraireNumerosCommande(texte),
      montantTotal: extraireMontantTotal(texte),
      domaine: domaineExpediteur(message.expediteur),
      asins: extraireAsins(texte),
    };
  }
  return {
    numerosCas: extraireNumerosCas(texte),
    asins: extraireAsins(texte),
    statut: detecterStatutAutorisation(texte),
  };
}
