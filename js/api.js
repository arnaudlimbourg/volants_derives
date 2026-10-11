// Échanges avec le web app Apps Script. En mode démo (?demo), tout reste dans le navigateur.

const DEMO = new URLSearchParams(location.search).has('demo');
let demoCatalogue = null;

export const isDemo = () => DEMO;

export async function loadCatalogue() {
  if (DEMO) {
    demoCatalogue = await getJson('fixtures/catalogue.json');
    return demoCatalogue;
  }
  return getJson(apiUrl());
}

export async function sendOrder(order) {
  if (DEMO) return fakeOrder(order);
  // text/plain évite la requête préalable CORS, que Apps Script ne sait pas traiter.
  const response = await fetch(apiUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(order),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** Erreur dont le message peut être montré tel quel (les autres sont des problèmes de réseau). */
export class ShopError extends Error {}

function apiUrl() {
  const url = window.CONFIG?.apiUrl || '';
  if (!url.startsWith('https://script.google.com/')) {
    throw new ShopError("L'adresse du serveur n'est pas renseignée dans config.js.");
  }
  return url;
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  if (data.ok === false) throw new ShopError(data.message);
  if (data.avertissements?.length) console.warn('Produits ignorés :', data.avertissements);
  return data;
}

async function fakeOrder(order) {
  await new Promise((resolve) => setTimeout(resolve, 600));
  const lines = order.lignes.map((ligne) => {
    const product = demoCatalogue.products.find((p) => p.nom === ligne.produit);
    const price = product.sizes.find((s) => s.label === ligne.taille).price;
    const joueur = order.joueurs.find((j) => j.nom === ligne.joueur);
    return { ...ligne, categorie: joueur ? joueur.categorie : '', prixUnitaire: price, total: price * ligne.quantite };
  });
  const total = lines.reduce((sum, line) => sum + line.total, 0);
  return { ok: true, orderNumber: 'V-DEMO', lines, total, emailSent: true };
}
