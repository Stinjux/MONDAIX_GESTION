import { api, badge, badgeComparaison, date, esc, montant, tableau } from '../outils.js';

function tuile(valeur, libelle, lien, alerte = true) {
  return `<a class="tuile ${valeur ? (alerte ? 'alerte' : '') : 'ok'}" href="${lien}">
    <div class="valeur">${valeur}</div><div class="libelle">${esc(libelle)}</div></a>`;
}

export async function pageTableauDeBord(zone) {
  const t = await api('/api/tableau-de-bord');
  const c = t.compteurs;
  zone.innerHTML = `
    <div class="entete"><div><h1>Tableau de bord</h1>
      <p class="aide">Ce qui reste à rapprocher. Chaîne achats : Ligne Google Sheets → commande → confirmation Gmail → facture → réception → envoi Amazon.
      Chaîne autorisations : ASIN → dossier → n° de cas → réponse Neo.</p></div></div>
    <div class="grille">
      ${tuile(c.commandes_sans_facture, 'Commandes sans facture', '#/commandes?filtre=sans_facture')}
      ${tuile(c.lignes_sans_commande, 'Lignes Sheets sans commande identifiée', '#/import-sheets')}
      ${tuile(c.asin_sans_autorisation_confirmee, 'ASIN sans statut d’autorisation confirmé', '#/autorisations')}
      ${tuile(c.gmail_a_traiter, 'Confirmations Gmail à rapprocher', '#/emails/gmail')}
      ${tuile(c.neo_a_traiter, 'Réponses Neo à rapprocher', '#/emails/neo')}
      ${tuile(c.ecarts_totaux, 'Totaux déclarés à vérifier (écart ou composition)', '#/commandes?filtre=ecart')}
      ${tuile(c.ecarts_couts, 'Écarts de coût d’achat à arbitrer', '#/produits?filtre=ecarts')}
      ${tuile(c.fournisseurs_a_valider, 'Lignes avec fournisseur à valider', '#/import-sheets')}
    </div>

    <h2>Commandes sans facture (${t.commandes_sans_facture.length})</h2>
    ${tableau(
      ['Commande', 'Fournisseur', 'Date', { t: 'Total déclaré', classe: 'num' }],
      t.commandes_sans_facture.map(
        (x) => `<tr><td><a href="#/commandes/${x.id}">${esc(x.numero_commande || `#${x.id} (n° à préciser)`)}</a></td>
          <td>${esc(x.fournisseur || '—')}</td><td>${date(x.date_commande)}</td><td class="num">${montant(x.total_declare)}</td></tr>`,
      ),
      'Toutes les commandes ont une facture.',
    )}

    <h2>Lignes Google Sheets sans commande identifiée (${t.lignes_sans_commande.length})</h2>
    ${tableau(
      ['Import', 'Ligne', 'ASIN', 'Lien d’origine', { t: 'Qté', classe: 'num' }, { t: 'Total déclaré (commande)', classe: 'num' }, 'Suggestion'],
      t.lignes_sans_commande.slice(0, 50).map((l) => {
        const p = t.propositions_lignes.find((x) => x.ligne_id === l.id);
        return `<tr><td>${esc(l.import_nom)}</td><td class="num">${l.numero_ligne}</td><td class="mono">${esc(l.asin || '?')}</td>
          <td><span class="lien-court" title="${esc(l.lien_original)}">${esc(l.lien_original || '—')}</span></td>
          <td class="num">${l.quantite ?? '?'}</td><td class="num">${montant(l.total_commande_declare)}</td>
          <td>${p ? badge(p.ambigu ? `${p.candidates.length} commandes possibles` : `commande ${p.candidates[0].numero_commande || '#' + p.candidates[0].commande_id}`, p.ambigu ? 'alerte' : 'info') : ''}</td></tr>`;
      }),
      'Aucune ligne en attente.',
    )}
    ${t.lignes_sans_commande.length > 50 ? `<p class="aide">… ${t.lignes_sans_commande.length - 50} autres dans <a href="#/import-sheets">Import Google Sheets</a>.</p>` : ''}

    <h2>ASIN sans statut d’autorisation confirmé (${t.asin_sans_autorisation_confirmee.length})</h2>
    ${tableau(
      ['ASIN', 'Titre', 'Dossier', 'N° de cas', 'Réponses Neo'],
      t.asin_sans_autorisation_confirmee.slice(0, 50).map(
        (a) => `<tr><td class="mono"><a href="#/produits/${a.asin}">${a.asin}</a></td><td>${esc(a.titre || '')}</td>
          <td>${a.dossier_id ? `<a href="#/dossiers/${a.dossier_id}">${esc(a.statut)}</a>` : badge('aucun dossier', 'alerte')}</td>
          <td class="mono">${esc(a.numero_cas || '—')}</td><td class="num">${a.reponses_neo}</td></tr>`,
      ),
      'Tous les ASIN ont un statut confirmé.',
    )}

    ${t.ecarts_totaux.length ? `<h2>Totaux déclarés à vérifier face à la facture (${t.ecarts_totaux.length})</h2>
    ${tableau(
      ['Commande', { t: 'Total déclaré', classe: 'num' }, 'État', 'Détail'],
      t.ecarts_totaux.map((x) => `<tr><td><a href="#/commandes/${x.id}">${esc(x.numero_commande || '#' + x.id)}</a></td>
        <td class="num">${montant(x.total_declare)}</td><td>${badgeComparaison(x.comparaison)}</td><td>${esc(x.comparaison.libelle)}</td></tr>`),
    )}` : ''}

    ${t.ecarts_couts.length ? `<h2>Écarts de coût d’achat unitaire (${t.ecarts_couts.length})</h2>
    ${tableau(
      ['ASIN', { t: 'Retenu', classe: 'num' }, { t: 'Autre valeur', classe: 'num' }, 'Source', { t: 'Écart', classe: 'num' }],
      t.ecarts_couts.map((e) => `<tr><td class="mono"><a href="#/produits/${e.asin}">${e.asin}</a></td><td class="num">${montant(e.retenu)}</td>
        <td class="num">${montant(e.valeur)}</td><td>${esc(e.source)} ${esc(e.reference || '')}</td><td class="num">${montant(e.ecart)}</td></tr>`),
    )}` : ''}

    ${t.factures_sans_commande.length ? `<h2>Factures sans commande (${t.factures_sans_commande.length})</h2>
      <p class="aide">À rattacher depuis <a href="#/factures">Factures</a>.</p>` : ''}
    ${t.lignes_envoi_sans_commande.length ? `<h2>Lignes d’envoi Amazon sans commande d’origine (${t.lignes_envoi_sans_commande.length})</h2>
      ${tableau(['Envoi', 'ASIN', { t: 'Qté', classe: 'num' }], t.lignes_envoi_sans_commande.map((l) => `<tr><td><a href="#/envois/${l.envoi_id}">${esc(l.numero_envoi || '#' + l.envoi_id)}</a></td><td class="mono">${l.asin}</td><td class="num">${l.quantite}</td></tr>`))}` : ''}
  `;
}
