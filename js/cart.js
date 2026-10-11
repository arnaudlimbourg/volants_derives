// Logique pure du panier. Une ligne : { produit, taille, joueur, quantite, prix, indisponible? }.
// Le prix sert uniquement à l'affichage : le serveur recalcule tout.

export const MAX_QUANTITY = 20;
export const ONE_SIZE = 'Taille unique';

export const lineKey = (line) => [line.produit, line.taille, line.joueur].join('|');

const clamp = (quantite) => Math.max(1, Math.min(MAX_QUANTITY, quantite));

export function addLine(lines, line) {
  const key = lineKey(line);
  if (!lines.some((l) => lineKey(l) === key)) return [...lines, { ...line, quantite: clamp(line.quantite) }];
  return lines.map((l) => (lineKey(l) === key ? { ...l, quantite: clamp(l.quantite + line.quantite) } : l));
}

export function setQuantity(lines, key, quantite) {
  if (quantite < 1) return removeLine(lines, key);
  return lines.map((l) => (lineKey(l) === key ? { ...l, quantite: clamp(quantite) } : l));
}

export const removeLine = (lines, key) => lines.filter((l) => lineKey(l) !== key);

export const cartCount = (lines) => lines.reduce((count, l) => count + l.quantite, 0);

export const cartTotal = (lines) => lines.reduce((sum, l) => sum + l.prix * l.quantite, 0);

export function groupByPlayer(lines) {
  const groups = new Map();
  for (const line of lines) {
    if (!groups.has(line.joueur)) groups.set(line.joueur, []);
    groups.get(line.joueur).push(line);
  }
  return [...groups].map(([joueur, items]) => ({ joueur, lines: items }));
}

export const renamePlayer = (lines, from, to) => lines.map((l) => (l.joueur === from ? { ...l, joueur: to } : l));

export const removePlayer = (lines, nom) => lines.filter((l) => l.joueur !== nom);

export function markUnavailable(lines, unavailable) {
  const gone = new Set(unavailable.map((u) => `${u.produit}|${u.taille}`));
  return lines.map((l) => ({ ...l, indisponible: gone.has(`${l.produit}|${l.taille}`) }));
}

export const toOrderLines = (lines) =>
  lines.map(({ produit, taille, quantite, joueur }) => ({ produit, taille, quantite, joueur }));

export function priceLabel(product) {
  const prices = product.sizes.map((s) => s.price);
  const min = Math.min(...prices);
  return min === Math.max(...prices) ? formatEuro(min) : `dès ${formatEuro(min)}`;
}

export function formatEuro(amount) {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
  }).format(amount);
}
