import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ouvrirBase } from '../src/db.js';
import { configSource, correspondFiltre, synchroniserSource, etatSynchro, indicesGmail } from '../src/services/synchroEmail.js';
import { listerEmails } from '../src/services/emails.js';
import { creerCommande } from '../src/services/commandes.js';
import { creerControleAcces, routePublique } from '../src/lib/acces.js';
import { estExposee, verifierStockage } from '../src/demarrer.js';

const ENV = {
  GMAIL_UTILISATEUR: 'moi@gmail.com',
  GMAIL_MOT_DE_PASSE: 'x',
  NEO_IMAP_HOTE: 'imap.exemple',
  NEO_UTILISATEUR: 'moi@neo',
  NEO_MOT_DE_PASSE: 'y',
  EMAIL_DATE_DEPART: '2026-08-01',
};

function eml({ de, sujet, corps, id, date = 'Mon, 10 Aug 2026 10:00:00 +0000' }) {
  return Buffer.from(`From: ${de}\r\nSubject: ${sujet}\r\nDate: ${date}\r\nMessage-ID: <${id}>\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${corps}\r\n`, 'utf8');
}

/** Faux client IMAP reproduisant le sous-ensemble d'imapflow utilisé. */
function fauxServeur(messages, { uidValidity = 1n } = {}) {
  const appels = { verrous: [], recherches: [] };
  const client = {
    mailbox: null,
    async connect() {},
    async logout() {},
    close() {},
    async list() {
      return [{ path: 'INBOX' }, { path: '[Gmail]/Tous les messages', specialUse: '\\All' }];
    },
    async getMailboxLock(path, options) {
      appels.verrous.push({ path, ...options });
      client.mailbox = { path, uidValidity };
      return { release() {} };
    },
    async search(q) {
      appels.recherches.push(q);
      if (q.since) return messages.filter((m) => m.date >= q.since).map((m) => m.uid);
      const debut = Number(q.uid.split(':')[0]);
      const r = messages.filter((m) => m.uid >= debut).map((m) => m.uid);
      return r.length ? r : [messages.at(-1).uid]; // comportement IMAP de « N:* »
    },
    async *fetch(uids, query) {
      for (const m of messages.filter((x) => uids.includes(x.uid))) {
        if (query.source) yield { uid: m.uid, source: m.source };
        else yield { uid: m.uid, size: m.source.length, envelope: { subject: m.sujet, from: [{ name: '', address: m.de }], date: m.date } };
      }
    },
  };
  return { client, appels };
}

let db;
beforeEach(() => {
  db = ouvrirBase(':memory:');
});

test('filtres par défaut : objet « order » / « shopping » pour Gmail ; Amazon + « brand approval » pour Neo', () => {
  const g = configSource('gmail', ENV);
  assert.ok(correspondFiltre(g, { sujet: 'Your Order #123 has shipped', expediteur: 'x@walmart.ca' }));
  assert.ok(correspondFiltre(g, { sujet: 'Merci pour votre shopping', expediteur: 'x@a.ca' }));
  assert.ok(correspondFiltre(g, { sujet: 'Orders update', expediteur: 'x@a.ca' }));
  assert.ok(!correspondFiltre(g, { sujet: 'Border crossing', expediteur: 'x@a.ca' }));
  assert.ok(!correspondFiltre(g, { sujet: 'Newsletter', expediteur: 'x@a.ca' }));
  const n = configSource('neo', ENV);
  assert.ok(correspondFiltre(n, { sujet: 'Amazon.com CA Brand Approval - case 123', expediteur: 'Amazon <brand-registry@amazon.com>' }));
  assert.ok(correspondFiltre(n, { sujet: 'Brand approval request', expediteur: 'notify@seller.amazon.ca' }));
  assert.ok(!correspondFiltre(n, { sujet: 'Brand approval', expediteur: 'scam@amaz0n.com' }));
  assert.ok(!correspondFiltre(n, { sujet: 'Your Amazon order', expediteur: 'x@amazon.com' }));
  assert.equal(configSource('neo', {}).configuree, false);
  assert.equal(configSource('gmail', { GMAIL_UTILISATEUR: ' moi@gmail.com ', GMAIL_MOT_DE_PASSE: 'abcd efgh ijkl mnop' }).motDePasse, 'abcdefghijklmnop');
  assert.equal(configSource('gmail', { GMAIL_UTILISATEUR: ' moi@gmail.com ', GMAIL_MOT_DE_PASSE: 'x' }).utilisateur, 'moi@gmail.com');
});

test('synchro Gmail : lecture seule, dossier « Tous les messages », filtre, rapprochement, incrémental', async () => {
  const cid = creerCommande(db, { numero_commande: '200012345678', lignes: [{ asin: 'B0AAAAAAA1', quantite: 1 }] });
  const messages = [
    { uid: 1, de: 'orders@walmart.ca', sujet: 'Old order', date: new Date('2026-07-15'), source: eml({ de: 'orders@walmart.ca', sujet: 'Old order', corps: 'x', id: 'a1' }) },
    { uid: 2, de: 'orders@walmart.ca', sujet: 'Your order confirmation', date: new Date('2026-08-10'), source: eml({ de: 'Walmart <orders@walmart.ca>', sujet: 'Your order confirmation', corps: 'Numéro de commande : 200012345678\nTotal : 20,00 $ — été', id: 'a2' }) },
    { uid: 3, de: 'news@shop.ca', sujet: 'Promo de la semaine', date: new Date('2026-08-11'), source: eml({ de: 'news@shop.ca', sujet: 'Promo', corps: 'x', id: 'a3' }) },
  ];
  const faux = fauxServeur(messages);
  const config = configSource('gmail', ENV);
  const r = await synchroniserSource(db, 'gmail', { config, creerClient: () => faux.client });
  assert.equal(r.echec, undefined);
  assert.equal(r.importes, 1);
  assert.deepEqual(faux.appels.verrous[0], { path: '[Gmail]/Tous les messages', readOnly: true });
  assert.ok(faux.appels.recherches[0].since, 'première synchro depuis la date de départ');
  const emails = listerEmails(db, { source: 'gmail' });
  assert.equal(emails.length, 1);
  assert.equal(emails[0].commande_id, cid, 'rapprochement automatique sur le n° exact');
  assert.match(emails[0].sujet, /order confirmation/);
  assert.match(db.prepare('SELECT corps FROM emails').get().corps, /été/, 'UTF-8 décodé correctement');

  // Deuxième passage : recherche incrémentale, aucun nouvel import
  const r2 = await synchroniserSource(db, 'gmail', { config, creerClient: () => faux.client });
  assert.equal(faux.appels.recherches[1].uid, '4:*');
  assert.equal(r2.examines, 0);
  assert.equal(r2.importes, 0);
  assert.equal(etatSynchro(db, 'gmail', config).derniere_erreur, null);
  assert.equal(etatSynchro(db, 'gmail', config).empreinte_mot_de_passe, '1 caractères, se termine par « x »');
});

test('synchro Neo : seuls les emails Amazon « brand approval » vont aux autorisations', async () => {
  const messages = [
    { uid: 10, de: 'brand-registry@amazon.com', sujet: 'Amazon.com CA Brand Approval', date: new Date('2026-08-05'), source: eml({ de: 'brand-registry@amazon.com', sujet: 'Amazon.com CA Brand Approval', corps: 'Case ID: 12345678901 ASIN B0AAAAAAA1 approved to sell', id: 'n1' }) },
    { uid: 11, de: 'ami@gmail.com', sujet: 'brand approval ?', date: new Date('2026-08-06'), source: eml({ de: 'ami@gmail.com', sujet: 'x', corps: 'x', id: 'n2' }) },
  ];
  const faux = fauxServeur(messages);
  const r = await synchroniserSource(db, 'neo', { config: configSource('neo', ENV), creerClient: () => faux.client });
  assert.equal(r.importes, 1);
  assert.deepEqual(faux.appels.verrous[0], { path: 'INBOX', readOnly: true });
  const [e] = listerEmails(db, { source: 'neo' });
  assert.equal(e.module, 'autorisations');
  assert.deepEqual(e.references_extraites.numerosCas, ['12345678901']);
});

test('échec de connexion enregistré sans exposer le mot de passe', async () => {
  const client = { async connect() { const e = new Error('Invalid credentials'); e.authenticationFailed = true; e.responseText = 'Application-specific password required'; throw e; }, close() {} };
  const r = await synchroniserSource(db, 'gmail', { config: configSource('gmail', ENV), creerClient: () => client });
  assert.match(r.echec, /Identifiants refusés/);
  assert.match(r.echec, /Application-specific password required/);
  assert.match(etatSynchro(db, 'gmail').derniere_erreur || etatSynchro(db, 'gmail', configSource('gmail', ENV)).derniere_erreur, /Identifiants refusés/);
});

test('accès protégé par mot de passe, webhook et /sante publics', () => {
  const controler = creerControleAcces({ utilisateur: 'admin', motDePasse: 'secret' });
  const req = (auth) => ({ headers: auth ? { authorization: 'Basic ' + Buffer.from(auth).toString('base64') } : {}, socket: { remoteAddress: '1.2.3.4' } });
  assert.equal(controler(req()), 'refuse');
  assert.equal(controler(req('admin:mauvais')), 'refuse');
  assert.equal(controler(req('admin:secret')), 'ok');
  for (let i = 0; i < 20; i++) controler(req('admin:x'));
  assert.equal(controler(req('admin:secret')), 'bloque');
  assert.ok(routePublique('POST', '/api/emails/neo/webhook'));
  assert.ok(routePublique('GET', '/sante'));
  assert.ok(!routePublique('GET', '/api/commandes'));
  assert.equal(creerControleAcces({})(req()), 'ok', 'sans mot de passe (usage local) : ouvert');
});

test('exposition détectée : hôte public, production ou cPanel / Passenger', () => {
  assert.equal(estExposee({}), false);
  assert.equal(estExposee({ HOST: '0.0.0.0' }), true);
  assert.equal(estExposee({ NODE_ENV: 'production' }), true);
  assert.equal(estExposee({ PASSENGER_APP_ENV: 'production' }), true);
});

test('Railway : la base doit être sur le volume persistant', () => {
  assert.equal(verifierStockage({}, '/app/data/mondaix.sqlite'), null, 'hors Railway : pas de contrôle');
  assert.match(verifierStockage({ RAILWAY_ENVIRONMENT: 'production' }, '/app/data/mondaix.sqlite'), /Aucun volume/);
  assert.equal(verifierStockage({ RAILWAY_ENVIRONMENT: 'production', RAILWAY_VOLUME_MOUNT_PATH: '/app/data' }, '/app/data/mondaix.sqlite'), null);
  assert.match(verifierStockage({ RAILWAY_ENVIRONMENT: 'production', RAILWAY_VOLUME_MOUNT_PATH: '/data' }, '/app/data/mondaix.sqlite'), /pas sur le volume/);
});

test('indices Gmail en cas de refus, sans exposer le mot de passe', () => {
  assert.deepEqual(indicesGmail(configSource('gmail', { GMAIL_UTILISATEUR: 'moi@gmail.com', GMAIL_MOT_DE_PASSE: 'abcd efgh ijkl mnop' })), []);
  const i = indicesGmail(configSource('gmail', { GMAIL_UTILISATEUR: 'moi', GMAIL_MOT_DE_PASSE: 'MonMotDePasse!' }));
  assert.match(i.join(), /adresse complète/);
  assert.match(i.join(), /14 caractère/);
  assert.ok(!i.join().includes('MonMotDePasse'));
  assert.match(indicesGmail(configSource('gmail', { GMAIL_UTILISATEUR: 'a@b.com', GMAIL_MOT_DE_PASSE: '"abcdefghijklmnop"' })).join(), /guillemets/);
});
