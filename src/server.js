// Serveur HTTP : API JSON + interface web statique.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { creerControleAcces, routePublique } from './lib/acces.js';
import { ErreurMetier, ecrireParametre, lireParametre } from './db.js';
import * as fournisseurs from './services/fournisseurs.js';
import * as inventaire from './services/inventaire.js';
import * as factures from './services/factures.js';
import * as couts from './services/couts.js';
import * as envois from './services/envois.js';
import * as autorisations from './services/autorisations.js';
import * as emails from './services/emails.js';
import * as tdb from './services/tableauDeBord.js';
import * as synchro from './services/synchroEmail.js';
import * as asins from './services/asins.js';
import * as stats from './services/statistiques.js';
import * as documents from './services/documentsFactures.js';
import * as ventes from './services/ventes.js';

const DOSSIER_PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

export function creerRoutes(db) {
  const routes = [];
  const r = (methode, chemin, gestionnaire) => {
    const cles = [];
    const re = new RegExp('^' + chemin.replace(/:(\w+)/g, (_, c) => (cles.push(c), '([^/]+)')) + '$');
    routes.push({ methode, re, cles, gestionnaire });
  };

  // Tableau de bord
  r('GET', '/api/tableau-de-bord', () => tdb.tableauDeBord(db));
  r('GET', '/api/statistiques', ({ q }) => stats.statistiques(db, q.get('periode') || '30j'));

  // Fournisseurs
  r('GET', '/api/fournisseurs', () => fournisseurs.listerFournisseurs(db));
  r('POST', '/api/fournisseurs', ({ corps }) => fournisseurs.creerFournisseur(db, corps));
  r('PUT', '/api/fournisseurs/:id', ({ p, corps }) => fournisseurs.modifierFournisseur(db, +p.id, corps));
  r('POST', '/api/fournisseurs/proposer', ({ corps }) => fournisseurs.proposerFournisseur(db, corps.lien));

  // Inventaire et coûts
  r('POST', '/api/imports/inventaire/analyser', ({ corps }) => inventaire.analyserInventaire(corps.texte));
  r('POST', '/api/imports/inventaire', ({ corps }) => inventaire.importerInventaire(db, corps));
  r('GET', '/api/imports/inventaire', () => inventaire.listerImportsInventaire(db));
  r('DELETE', '/api/imports/inventaire/:id', ({ p }) => inventaire.supprimerImportInventaire(db, +p.id));
  r('POST', '/api/imports/inventaire/reinitialiser', () => inventaire.reinitialiserInventaire(db));
  r('POST', '/api/imports/ventes', ({ corps }) => ventes.importerVentes(db, corps));
  r('GET', '/api/imports/ventes', () => ventes.listerImportsVentes(db));
  r('DELETE', '/api/imports/ventes/:id', ({ p }) => ventes.supprimerImportVentes(db, +p.id));
  r('GET', '/api/produits', () => asins.listerAsins(db));
  r('GET', '/api/produits/:asin', ({ p }) => asins.ficheAsin(db, p.asin));
  r('PUT', '/api/produits/:asin', ({ p, corps }) => {
    db.prepare("UPDATE produits SET titre = ?, sku = ?, updated_at = datetime('now') WHERE asin = ?").run(corps.titre || null, corps.sku || null, p.asin);
  });
  r('POST', '/api/produits/:asin/couts', ({ p, corps }) => {
    const res = couts.ajouterCout(db, { asin: p.asin, montant: corps.montant, source: 'manuel', reference: corps.reference || 'saisie manuelle' });
    if (corps.retenir) couts.retenirCout(db, p.asin, res.entree.id);
    return res;
  });
  r('POST', '/api/produits/:asin/retenir', ({ p, corps }) => couts.retenirCout(db, p.asin, +corps.cout_id));
  r('GET', '/api/ecarts-couts', () => couts.ecartsCouts(db));

  // Dépenses
  r('GET', '/api/depenses', ({ q }) => couts.listerDepenses(db, Object.fromEntries(q)));
  r('POST', '/api/depenses', ({ corps }) => couts.creerDepense(db, corps));
  r('DELETE', '/api/depenses/:id', ({ p }) => couts.supprimerDepense(db, +p.id));

  // Factures
  r('GET', '/api/factures', () => factures.listerFactures(db));
  r('POST', '/api/factures', ({ corps }) => factures.creerFacture(db, corps));
  r('DELETE', '/api/factures/:id', ({ p }) => factures.supprimerFacture(db, +p.id));
  r('POST', '/api/factures/:id/annuler', ({ p, corps }) => factures.annulerFacture(db, +p.id, corps));
  r('POST', '/api/factures/:id/retablir', ({ p }) => factures.retablirFacture(db, +p.id));
  r('PUT', '/api/factures/:id/lignes', ({ p, corps }) => factures.modifierLignesFacture(db, +p.id, corps.lignes));
  r('POST', '/api/factures/:id/lignes', ({ p, corps }) => factures.ajouterLigneFacture(db, +p.id, corps));
  r('DELETE', '/api/facture-lignes/:id', ({ p }) => factures.retirerLigneFacture(db, +p.id));

  // Factures déposées (PDF / image) et extraction
  r('GET', '/api/factures/documents', ({ q }) => ({
    extraction_configuree: documents.extractionConfiguree(),
    documents: documents.listerDocuments(db, { statut: q.get('statut') || undefined }),
  }));
  r('POST', '/api/factures/documents', ({ corps }) => documents.deposerDocument(db, corps));
  r('GET', '/api/factures/documents/:id', ({ p }) => ({ ...documents.lireDocument(db, +p.id), extraction_configuree: documents.extractionConfiguree() }));
  r('GET', '/api/factures/documents/:id/fichier', ({ p }) => ({ __fichier: documents.fichierDocument(db, +p.id) }));
  r('POST', '/api/factures/documents/:id/extraire', ({ p }) => documents.extraireDocument(db, +p.id));
  r('POST', '/api/factures/documents/:id/valider', ({ p, corps }) => documents.validerDocument(db, +p.id, corps));
  r('DELETE', '/api/factures/documents/:id', ({ p }) => documents.supprimerDocument(db, +p.id));

  // Envois Amazon
  r('GET', '/api/envois', () => envois.listerEnvois(db));
  r('POST', '/api/envois', ({ corps }) => ({ id: envois.creerEnvoi(db, corps) }));
  r('GET', '/api/envois/:id', ({ p }) => envois.lireEnvoi(db, +p.id));
  r('PUT', '/api/envois/:id', ({ p, corps }) => envois.modifierEnvoi(db, +p.id, corps));
  r('DELETE', '/api/envois/:id', ({ p }) => envois.supprimerEnvoi(db, +p.id));
  r('POST', '/api/envois/:id/reception', ({ p, corps }) => envois.enregistrerReception(db, +p.id, corps));
  r('POST', '/api/envois/:id/tout-recu', ({ p, corps }) => envois.toutRecu(db, +p.id, corps));
  r('POST', '/api/envois/:id/lignes', ({ p, corps }) => envois.ajouterLigneEnvoi(db, +p.id, corps));
  r('PUT', '/api/envoi-lignes/:id', ({ p, corps }) => envois.modifierLigneEnvoi(db, +p.id, corps));
  r('DELETE', '/api/envoi-lignes/:id', ({ p }) => envois.supprimerLigneEnvoi(db, +p.id));

  // Autorisations
  r('GET', '/api/dossiers', () => autorisations.listerDossiers(db));
  r('GET', '/api/autorisations/asin', () => autorisations.etatParAsin(db));
  r('POST', '/api/dossiers', ({ corps }) => {
    const id = autorisations.creerDossier(db, corps);
    emails.relancerRapprochements(db, 'neo');
    return { id };
  });
  r('GET', '/api/dossiers/:id', ({ p }) => {
    const d = autorisations.lireDossier(db, +p.id);
    const reponses = new Set(d.reponses.map((r) => r.id));
    return { ...d, emails_asin: emails.emailsPourAsin(db, d.asin).filter((e) => !reponses.has(e.id)) };
  });
  r('PUT', '/api/dossiers/:id', ({ p, corps }) => {
    autorisations.modifierDossier(db, +p.id, corps);
    emails.relancerRapprochements(db, 'neo');
  });
  r('DELETE', '/api/dossiers/:id', ({ p }) => autorisations.supprimerDossier(db, +p.id));

  // Emails (Gmail et Neo, associés aux ASIN)
  r('GET', '/api/emails/sources', () => emails.etatSources(db).map((s) => ({ ...s, synchro: synchro.etatSynchro(db, s.source) })));
  r('POST', '/api/emails/synchroniser', async ({ corps }) => {
    if (corps.source) {
      if (!(corps.source in emails.SOURCES_EMAIL)) throw new ErreurMetier('Source inconnue.', 404);
      return [await synchro.synchroniserSource(db, corps.source)];
    }
    return synchro.synchroniserTout(db);
  });
  r('GET', '/api/emails', ({ q }) => emails.listerEmails(db, { source: q.get('source'), statut: q.get('statut') }));
  r('GET', '/api/emails/:id', ({ p }) => emails.lireEmail(db, +p.id));
  r('POST', '/api/emails/:source/eml', ({ p, corps }) => {
    const fichiers = Array.isArray(corps.fichiers) ? corps.fichiers : [corps.texte];
    return fichiers.map((brut) => emails.ingererEml(db, p.source, brut));
  });
  r('POST', '/api/emails/:source/manuel', ({ p, corps }) =>
    emails.ingererEmail(db, p.source, { expediteur: corps.expediteur, sujet: corps.sujet, date: corps.date ? new Date(corps.date).toISOString() : null, corps: corps.corps }, 'manuel'),
  );
  r('POST', '/api/emails/:source/webhook', ({ p, corps, entetes }) => {
    verifierJeton(db, entetes['x-mondaix-token']);
    const message = { messageId: corps.message_id, expediteur: corps.from, sujet: corps.subject, date: corps.date ? new Date(corps.date).toISOString() : null, corps: corps.text };
    return corps.raw ? emails.ingererEml(db, p.source, corps.raw) : emails.ingererEmail(db, p.source, message, 'webhook');
  });
  r('POST', '/api/emails/relancer', ({ corps }) => ({ traites: emails.relancerRapprochements(db, corps.source || null) }));
  r('POST', '/api/emails/:id/dissocier', ({ p }) => emails.dissocierEmail(db, +p.id));
  r('POST', '/api/emails/:id/ignorer', ({ p }) => emails.ignorerEmail(db, +p.id));
  r('POST', '/api/emails/:id/liens', ({ p, corps }) => emails.lierEmail(db, +p.id, corps));
  r('DELETE', '/api/email-liens/:id', ({ p }) => emails.delierEmail(db, +p.id));
  r('POST', '/api/emails/:id/statut', ({ p, corps }) => emails.appliquerStatutNeo(db, +p.id, corps.statut));

  // Paramètres
  r('GET', '/api/parametres', () => ({
    inclure_taxes: lireParametre(db, 'couts.inclure_taxes') === '1',
    tolerance: Number(lireParametre(db, 'rapprochement.tolerance')),
    webhook_configure: Boolean(lireParametre(db, 'email.webhook_token')),
    amazon_domaine: lireParametre(db, 'amazon.domaine'),
  }));
  r('PUT', '/api/parametres', ({ corps }) => {
    if (corps.inclure_taxes !== undefined) ecrireParametre(db, 'couts.inclure_taxes', corps.inclure_taxes ? '1' : '0');
    if (corps.tolerance !== undefined) ecrireParametre(db, 'rapprochement.tolerance', String(Math.max(0, Number(corps.tolerance) || 0)));
    if (corps.webhook_token !== undefined) ecrireParametre(db, 'email.webhook_token', String(corps.webhook_token || ''));
    if (corps.amazon_domaine !== undefined) {
      const d = String(corps.amazon_domaine).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      if (!/^(www\.)?amazon\.[a-z]{2,3}(\.[a-z]{2})?$/.test(d)) throw new ErreurMetier('Domaine Amazon invalide (ex. www.amazon.ca).');
      ecrireParametre(db, 'amazon.domaine', d);
    }
  });

  r('GET', '/api/journal', ({ q }) =>
    db.prepare('SELECT * FROM journal ORDER BY id DESC LIMIT ?').all(Math.min(500, Number(q.get('limite')) || 100)),
  );
  r('GET', '/api/references', () => ({
    statuts_dossier: autorisations.STATUTS_DOSSIER,
    statuts_envoi: envois.STATUTS_ENVOI,
    etats_suivi: envois.ETATS_SUIVI,
    types_depense: couts.TYPES_DEPENSE,
    sources_cout: couts.LIBELLES_SOURCE_COUT,
    sources_email: emails.SOURCES_EMAIL,
    periodes: stats.PERIODES,
    amazon_domaine: lireParametre(db, 'amazon.domaine') || 'www.amazon.ca',
  }));

  return routes;
}

function verifierJeton(db, recu) {
  const attendu = lireParametre(db, 'email.webhook_token') || process.env.MONDAIX_WEBHOOK_TOKEN || '';
  if (!attendu) throw new ErreurMetier('Webhook désactivé : définissez un jeton dans les paramètres.', 403);
  const a = Buffer.from(String(recu || ''));
  const b = Buffer.from(attendu);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ErreurMetier('Jeton invalide.', 401);
}

async function lireCorps(req) {
  const morceaux = [];
  let taille = 0;
  for await (const m of req) {
    taille += m.length;
    if (taille > 30 * 1024 * 1024) throw new ErreurMetier('Requête trop volumineuse.', 413);
    morceaux.push(m);
  }
  const texte = Buffer.concat(morceaux).toString('utf8');
  if (!texte) return {};
  if ((req.headers['content-type'] || '').includes('application/json')) {
    try {
      return JSON.parse(texte);
    } catch {
      throw new ErreurMetier('JSON invalide.');
    }
  }
  return { texte };
}

function repondre(res, statut, donnees) {
  res.writeHead(statut, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(donnees ?? { ok: true }));
}

async function servirStatique(res, chemin) {
  const relatif = normalize(chemin === '/' ? '/index.html' : chemin).replace(/^(\.\.[/\\])+/, '');
  const fichier = join(DOSSIER_PUBLIC, relatif);
  if (!fichier.startsWith(DOSSIER_PUBLIC)) return repondre(res, 403, { erreur: 'Interdit' });
  try {
    const contenu = await readFile(fichier);
    res.writeHead(200, { 'Content-Type': TYPES[extname(fichier)] || 'application/octet-stream' });
    res.end(contenu);
  } catch {
    const index = await readFile(join(DOSSIER_PUBLIC, 'index.html'));
    res.writeHead(200, { 'Content-Type': TYPES['.html'] });
    res.end(index);
  }
}

export function creerServeur(db, { acces = {} } = {}) {
  const routes = creerRoutes(db);
  const controler = creerControleAcces(acces);
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!routePublique(req.method, url.pathname)) {
      const verdict = controler(req);
      if (verdict === 'bloque') return repondre(res, 429, { erreur: 'Trop de tentatives. Réessayez dans 15 minutes.' });
      if (verdict === 'refuse') {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Mondaix Gestion", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Authentification requise.');
      }
    }
    if (url.pathname === '/sante') return repondre(res, 200, { ok: true });
    if (!url.pathname.startsWith('/api/')) return servirStatique(res, decodeURIComponent(url.pathname));
    try {
      for (const route of routes) {
        if (route.methode !== req.method) continue;
        const m = url.pathname.match(route.re);
        if (!m) continue;
        const p = Object.fromEntries(route.cles.map((c, i) => [c, decodeURIComponent(m[i + 1])]));
        const corps = ['POST', 'PUT', 'DELETE'].includes(req.method) ? await lireCorps(req) : {};
        const resultat = await route.gestionnaire({ p, q: url.searchParams, corps, entetes: req.headers });
        if (resultat && resultat.__fichier) {
          const f = resultat.__fichier;
          res.writeHead(200, {
            'Content-Type': f.type,
            'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.nom)}`,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'private, max-age=3600',
          });
          return res.end(f.contenu);
        }
        return repondre(res, 200, resultat);
      }
      repondre(res, 404, { erreur: 'Route inconnue.' });
    } catch (e) {
      if (e instanceof ErreurMetier) return repondre(res, e.statut, { erreur: e.message });
      if (/constraint/i.test(e.message || '')) return repondre(res, 409, { erreur: `Opération refusée par la base : ${e.message}` });
      console.error(e);
      repondre(res, 500, { erreur: 'Erreur interne.' });
    }
  });
}
