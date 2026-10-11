import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGas, plain } from './support/gas.js';

function setup() {
  const env = createGas();
  env.gas.setupSheet();
  env.orderRows = () => env.sheet('Commandes').rows.slice(1);
  return env;
}

function validOrder(overrides = {}) {
  return {
    clientId: 'client-1',
    website: '',
    parent: { nom: 'Camille Martin', role: 'Parent de joueur', telephone: '06 12 34 56 78', email: 'Camille@Example.com' },
    joueurs: [{ nom: 'Léo', categorie: 'U11' }, { nom: 'Inès', categorie: 'U7' }],
    lignes: [
      { produit: 'Short', taille: '8-10 ans', quantite: 2, joueur: 'Léo' },
      { produit: 'Casquette', taille: 'Taille unique', quantite: 1, joueur: 'Inès' },
    ],
    ...overrides,
  };
}

const place = (gas, order) => plain(gas.placeOrder(order));

test('commande valide : lignes écrites, numéro attribué, email envoyé', () => {
  const { gas, orderRows, mails } = setup();
  const result = place(gas, validOrder());

  assert.equal(result.ok, true);
  assert.equal(result.orderNumber, 'V-0001');
  assert.equal(result.total, 75);
  assert.equal(result.emailSent, true);
  assert.deepEqual(result.lines[0], {
    joueur: 'Léo', categorie: 'U11', produit: 'Short', taille: '8-10 ans', quantite: 2, prixUnitaire: 25, total: 50,
  });

  const rows = orderRows();
  assert.equal(rows.length, 2);
  assert.equal(Object.prototype.toString.call(rows[0][0]), '[object Date]');
  assert.deepEqual(rows[0].slice(1), [
    'V-0001', 'client-1', 'Camille Martin', 'Parent de joueur', '06 12 34 56 78', 'camille@example.com',
    'Léo', 'U11', 'Short', '8-10 ans', 2, 25, 50, '',
  ]);
  assert.deepEqual(rows[1].slice(7, 14), ['Inès', 'U7', 'Casquette', 'Taille unique', 1, 25, 25]);

  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'camille@example.com');
  assert.match(mails[0].subject, /V-0001/);
  assert.match(mails[0].htmlBody, /https:\/\/www\.onparticipe\.fr\/c\/B11D7skx/);
  assert.match(mails[0].htmlBody, /75 €/);
});

test('les numéros de commande se suivent', () => {
  const { gas } = setup();
  place(gas, validOrder());
  assert.equal(place(gas, validOrder({ clientId: 'client-2' })).orderNumber, 'V-0002');
});

test('renvoyer la même commande ne la duplique pas', () => {
  const { gas, orderRows, mails } = setup();
  place(gas, validOrder());
  const again = place(gas, validOrder());
  assert.equal(again.ok, true);
  assert.equal(again.orderNumber, 'V-0001');
  assert.equal(again.duplicate, true);
  assert.equal(orderRows().length, 2);
  assert.equal(mails.length, 1);
});

test('les prix envoyés par le navigateur sont ignorés', () => {
  const { gas } = setup();
  const lignes = validOrder().lignes.map((l) => ({ ...l, prix: 1, prixUnitaire: 1 }));
  assert.equal(place(gas, validOrder({ lignes })).total, 75);
});

test('commandes fermées', () => {
  const { gas, sheet, orderRows } = setup();
  sheet('Réglages').rows.find((row) => row[0] === 'ouvert')[1] = 'non';
  const result = place(gas, validOrder());
  assert.equal(result.ok, false);
  assert.equal(result.error, 'closed');
  assert.equal(orderRows().length, 0);
});

test('article désactivé ou taille inconnue : indisponible', () => {
  const { gas, sheet, orderRows } = setup();
  sheet('Produits').rows.find((row) => row[2] === 'Casquette')[0] = 'non';
  const lignes = [...validOrder().lignes, { produit: 'Short', taille: 'XXXXL', quantite: 1, joueur: 'Léo' }];
  const result = place(gas, validOrder({ lignes }));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'unavailable');
  assert.deepEqual(result.unavailable, [
    { produit: 'Casquette', taille: 'Taille unique' },
    { produit: 'Short', taille: 'XXXXL' },
  ]);
  assert.equal(orderRows().length, 0);
});

test('champs du parent invalides', () => {
  const { gas, orderRows } = setup();
  const result = place(gas, validOrder({
    parent: { nom: ' ', role: 'Pirate', telephone: '12', email: 'pas-un-email' },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid');
  assert.equal(result.errors.length, 4);
  assert.equal(orderRows().length, 0);
});

test('joueur inconnu ou sans catégorie', () => {
  const { gas } = setup();
  const unknown = place(gas, validOrder({ lignes: [{ produit: 'Bonnet', taille: 'Taille unique', quantite: 1, joueur: 'Zoé' }] }));
  assert.deepEqual(unknown.errors, ['Joueur inconnu : Zoé.']);

  const noCategory = place(gas, validOrder({ joueurs: [{ nom: 'Léo', categorie: '' }, { nom: 'Inès', categorie: 'U7' }] }));
  assert.deepEqual(noCategory.errors, ['Choisissez la catégorie de Léo.']);
});

test('quantités invalides', () => {
  const { gas } = setup();
  for (const quantite of [0, 21, 1.5, 'abc']) {
    const result = place(gas, validOrder({ lignes: [{ produit: 'Bonnet', taille: 'Taille unique', quantite, joueur: 'Léo' }] }));
    assert.equal(result.error, 'invalid', String(quantite));
  }
});

test('panier vide ou identifiant manquant', () => {
  const { gas } = setup();
  assert.deepEqual(place(gas, validOrder({ lignes: [] })).errors, ['Le panier est vide.']);
  assert.deepEqual(place(gas, validOrder({ clientId: '' })).errors, ['Identifiant de commande manquant.']);
});

test('un article peut être pour le parent lui-même', () => {
  const { gas, orderRows } = setup();
  const result = place(gas, validOrder({
    joueurs: [],
    lignes: [{ produit: 'Bonnet', taille: 'Taille unique', quantite: 1, joueur: '' }],
  }));
  assert.equal(result.ok, true);
  assert.equal(result.total, 20);
  assert.deepEqual(orderRows()[0].slice(7, 10), ['', '', 'Bonnet']);
});

test('pot de miel rempli : faux succès, rien enregistré', () => {
  const { gas, orderRows, mails } = setup();
  const result = place(gas, validOrder({ website: 'http://spam.example' }));
  assert.equal(result.ok, true);
  assert.equal(orderRows().length, 0);
  assert.equal(mails.length, 0);
});

test('les textes saisis ne peuvent pas devenir des formules ni casser l’email', () => {
  const { gas, mails } = setup();
  assert.equal(gas.text_('=1+1'), "'=1+1");
  assert.equal(gas.text_(''), '');
  place(gas, validOrder({ parent: { ...validOrder().parent, nom: '<b>Camille</b>' } }));
  assert.match(mails[0].htmlBody, /&lt;b&gt;Camille&lt;\/b&gt;/);
});

test("si l'email échoue, la commande est quand même enregistrée", () => {
  const { gas, orderRows, setMailFailure } = setup();
  setMailFailure(true);
  const result = place(gas, validOrder());
  assert.equal(result.ok, true);
  assert.equal(result.emailSent, false);
  assert.equal(orderRows().length, 2);
});

test('doPost : JSON invalide, erreur interne, commande valide', () => {
  const { gas, sheets } = setup();
  const post = (contents) => JSON.parse(gas.doPost({ postData: { contents } }).text);

  assert.equal(post('{').error, 'invalid');
  assert.equal(post(JSON.stringify(validOrder())).orderNumber, 'V-0001');

  sheets.delete('Produits');
  const broken = post(JSON.stringify(validOrder({ clientId: 'client-2' })));
  assert.equal(broken.error, 'server');
  assert.match(broken.message, /réessayez/);
});
