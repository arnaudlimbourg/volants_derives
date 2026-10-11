import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGas, plain } from './support/gas.js';

const { gas } = createGas();

test('parseSizes : sans tailles, article en taille unique', () => {
  assert.deepEqual(plain(gas.parseSizes('', '25')), [{ label: 'Taille unique', price: 25 }]);
});

test('parseSizes : les tailles sans prix prennent le prix de base', () => {
  assert.deepEqual(plain(gas.parseSizes('S; M', '15')), [
    { label: 'S', price: 15 },
    { label: 'M', price: 15 },
  ]);
});

test('parseSizes : une taille peut avoir son propre prix', () => {
  assert.deepEqual(plain(gas.parseSizes('6-8 ans:25; Adulte - S', '30')), [
    { label: '6-8 ans', price: 25 },
    { label: 'Adulte - S', price: 30 },
  ]);
});

test('parseSizes : accepte la virgule et le symbole euro', () => {
  assert.deepEqual(plain(gas.parseSizes('XS:7,50 €', '')), [{ label: 'XS', price: 7.5 }]);
  assert.deepEqual(plain(gas.parseSizes('', '25,00 €')), [{ label: 'Taille unique', price: 25 }]);
});

test('parseSizes : prix manquant ou invalide', () => {
  assert.throws(() => gas.parseSizes('', ''), /prix manquant/);
  assert.throws(() => gas.parseSizes('S; M', ''), /prix manquant pour la taille « S »/);
  assert.throws(() => gas.parseSizes('S:abc', '10'), /prix invalide/);
});

test('imageUrl : liens Google Drive convertis en vignette', () => {
  const thumbnail = 'https://drive.google.com/thumbnail?id=abc_123-X&sz=w800';
  assert.equal(gas.imageUrl('https://drive.google.com/file/d/abc_123-X/view?usp=sharing'), thumbnail);
  assert.equal(gas.imageUrl('https://drive.google.com/open?id=abc_123-X'), thumbnail);
  assert.equal(gas.imageUrl(' https://example.com/short.jpg '), 'https://example.com/short.jpg');
  assert.equal(gas.imageUrl(''), '');
});

test('buildProducts : ignore les inactifs, signale les lignes invalides', () => {
  const { products, errors } = plain(gas.buildProducts([
    { actif: 'oui', section: "Textile d'équipe", nom: 'Short', prix: '30', tailles: 'S; M', image: '', note: '' },
    { actif: 'non', section: '', nom: 'Ancien modèle', prix: '10', tailles: '', image: '', note: '' },
    { actif: 'oui', section: '', nom: 'Cassé', prix: '', tailles: '', image: '', note: '' },
    { actif: 'oui', section: '', nom: '', prix: '10', tailles: '', image: '', note: '' },
  ]));
  assert.deepEqual(products, [{
    nom: 'Short',
    section: "Textile d'équipe",
    sizes: [{ label: 'S', price: 30 }, { label: 'M', price: 30 }],
    image: '',
    note: '',
  }]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /ligne 4 \(Cassé\)/);
});

function setup() {
  const env = createGas();
  env.gas.setupSheet();
  return env;
}

test('setupSheet crée les onglets et le catalogue de départ', () => {
  const { gas, sheet, warnings } = setup();
  for (const name of ['Produits', 'Catégories', 'Réglages', 'Commandes', 'Récap']) assert.ok(sheet(name), name);
  assert.equal(sheet('Commandes').rows[0][1], 'N° commande');

  const catalogue = plain(gas.getCatalogue());
  assert.equal(catalogue.products.length, 21);
  assert.deepEqual(warnings, []);
  assert.equal(catalogue.settings.ouvert, true);
  assert.equal(catalogue.settings.lienPaiement, 'https://www.onparticipe.fr/c/B11D7skx');
  assert.ok(catalogue.categories.includes('U11'));
  assert.deepEqual(catalogue.roles, ['Parent de joueur', 'Joueur', 'Autre']);

  const short = catalogue.products.find((p) => p.nom === 'Short');
  assert.deepEqual(short.sizes.find((s) => s.label === '8-10 ans'), { label: '8-10 ans', price: 25 });
  assert.deepEqual(short.sizes.find((s) => s.label === 'Adulte - M'), { label: 'Adulte - M', price: 30 });
  assert.deepEqual(catalogue.products.find((p) => p.nom === 'Casquette').sizes, [{ label: 'Taille unique', price: 25 }]);

  assert.match(sheet('Récap').formulas['1,1'], /^=QUERY\(Commandes!A:O,/);
  assert.match(sheet('Récap').formulas['1,6'], /^=QUERY\(Commandes!A:O,/);
});

test('setupSheet ne réécrit pas un onglet existant', () => {
  const { gas, sheet } = setup();
  sheet('Produits').rows[1][0] = 'non';
  gas.setupSheet();
  assert.equal(sheet('Produits').rows[1][0], 'non');
  assert.equal(gas.getCatalogue().products.length, 20);
});

test('doGet renvoie le catalogue en JSON', () => {
  const { gas } = setup();
  const output = gas.doGet();
  assert.deepEqual(JSON.parse(output.text), plain(gas.getCatalogue()));
});
