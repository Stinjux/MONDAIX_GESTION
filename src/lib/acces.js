// Protection de l'application hébergée : authentification HTTP Basic (via HTTPS chez l'hébergeur)
// et limitation des tentatives échouées par adresse IP.
import { timingSafeEqual } from 'node:crypto';

const FENETRE_MS = 15 * 60_000;
const ECHECS_MAX = 20;

function egal(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Routes accessibles sans mot de passe (le webhook a son propre jeton). */
export function routePublique(methode, chemin) {
  return (methode === 'GET' && chemin === '/sante') || (methode === 'POST' && /^\/api\/emails\/(gmail|neo)\/webhook$/.test(chemin));
}

/**
 * Retourne une fonction (req) → 'ok' | 'refuse' | 'bloque'.
 * Sans mot de passe configuré, tout est autorisé (usage local).
 */
export function creerControleAcces({ utilisateur = 'admin', motDePasse = '' } = {}) {
  const echecs = new Map();
  return (req) => {
    if (!motDePasse) return 'ok';
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const maintenant = Date.now();
    const e = echecs.get(ip);
    if (e && maintenant - e.debut > FENETRE_MS) echecs.delete(ip);
    if ((echecs.get(ip)?.n || 0) >= ECHECS_MAX) return 'bloque';
    const m = String(req.headers.authorization || '').match(/^Basic\s+(.+)$/i);
    if (m) {
      const [u, ...reste] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
      if (egal(u, utilisateur) && egal(reste.join(':'), motDePasse)) return 'ok';
      const courant = echecs.get(ip) || { n: 0, debut: maintenant };
      courant.n++;
      echecs.set(ip, courant);
    }
    return 'refuse';
  };
}

export function estLocal(hote) {
  return ['127.0.0.1', 'localhost', '::1'].includes(hote);
}
