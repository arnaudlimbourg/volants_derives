import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addLine, setQuantity, removeLine, cartCount, cartTotal, groupByPlayer,
  renamePlayer, removePlayer, markUnavailable, toOrderLines, priceLabel, formatEuro, lineKey,
} from '../js/cart.js';

const short = { produit: 'Short', taille: '8-10 ans', joueur: 'Léo', quantite: 1, prix: 25 };
const casquette = { produit: 'Casquette', taille: 'Taille unique', joueur: 'Inès', quantite: 1, prix: 25 };
const spaces = (text) => text.replace(/\s/g, ' ');

test('addLine ajoute une nouvelle ligne', () => {
  assert.deepEqual(addLine([], short), [short]);
});

test('addLine fusionne même produit, taille et joueur', () => {
  const lines = addLine([short], { ...short, quantite: 2 });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].quantite, 3);
});

test('addLine distingue les joueurs', () => {
  assert.equal(addLine([short], { ...short, joueur: 'Inès' }).length, 2);
});

test('la quantité est plafonnée à 20', () => {
  const lines = addLine(addLine([], { ...short, quantite: 15 }), { ...short, quantite: 10 });
  assert.equal(lines[0].quantite, 20);
});

test('setQuantity modifie, et supprime à 0', () => {
  assert.equal(setQuantity([short], lineKey(short), 4)[0].quantite, 4);
  assert.deepEqual(setQuantity([short], lineKey(short), 0), []);
});

test('removeLine supprime la ligne', () => {
  assert.deepEqual(removeLine([short, casquette], lineKey(short)), [casquette]);
});

test('cartCount et cartTotal', () => {
  const lines = [{ ...short, quantite: 2 }, casquette];
  assert.equal(cartCount(lines), 3);
  assert.equal(cartTotal(lines), 75);
});

test('cartTotal ignore les lignes indisponibles', () => {
  assert.equal(cartTotal([{ ...short, quantite: 2 }, { ...casquette, indisponible: true }]), 50);
});

test("groupByPlayer garde l'ordre d'ajout", () => {
  const other = { ...short, produit: 'Sweat' };
  assert.deepEqual(groupByPlayer([short, casquette, other]), [
    { joueur: 'Léo', lines: [short, other] },
    { joueur: 'Inès', lines: [casquette] },
  ]);
});

test('renamePlayer et removePlayer', () => {
  assert.equal(renamePlayer([short, casquette], 'Léo', 'Léon')[0].joueur, 'Léon');
  assert.deepEqual(removePlayer([short, casquette], 'Léo'), [casquette]);
});

test('renamePlayer vers un nom existant fusionne les lignes identiques', () => {
  const merged = renamePlayer([short, { ...short, joueur: 'Léon', quantite: 2 }], 'Léo', 'Léon');
  assert.deepEqual(merged, [{ ...short, joueur: 'Léon', quantite: 3 }]);
});

test('markUnavailable signale les lignes indisponibles', () => {
  const lines = markUnavailable([short, casquette], [{ produit: 'Casquette', taille: 'Taille unique' }]);
  assert.equal(lines[0].indisponible, false);
  assert.equal(lines[1].indisponible, true);
});

test('toOrderLines ne garde que ce que le serveur attend', () => {
  assert.deepEqual(toOrderLines([{ ...short, indisponible: false }]), [
    { produit: 'Short', taille: '8-10 ans', quantite: 1, joueur: 'Léo' },
  ]);
});

test('priceLabel : prix unique ou « dès »', () => {
  assert.equal(spaces(priceLabel({ sizes: [{ label: 'S', price: 15 }, { label: 'M', price: 15 }] })), '15 €');
  assert.equal(spaces(priceLabel({ sizes: [{ label: '8 ans', price: 25 }, { label: 'S', price: 30 }] })), 'dès 25 €');
});

test('formatEuro affiche les centimes seulement si besoin', () => {
  assert.equal(spaces(formatEuro(7.5)), '7,50 €');
  assert.equal(spaces(formatEuro(120)), '120 €');
});
