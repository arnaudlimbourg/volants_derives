/**
 * Backend de la boutique des Français Volants.
 *
 * À coller dans la feuille Google du club : Extensions → Apps Script.
 * Installation et déploiement : voir SETUP.md.
 */

const SHEETS = {
  produits: 'Produits',
  categories: 'Catégories',
  reglages: 'Réglages',
  commandes: 'Commandes',
  recap: 'Récap',
};

const PRODUITS_HEADERS = ['Actif', 'Section', 'Nom', 'Prix', 'Tailles', 'Image', 'Note'];
const ROLES = ['Parent de joueur', 'Joueur', 'Autre'];
const ONE_SIZE = 'Taille unique';

// ---------- Catalogue ----------

function buildProducts(rows) {
  const products = [];
  const errors = [];
  rows.forEach((row, index) => {
    const nom = clean_(row.nom);
    if (!nom || !isYes_(row.actif)) return;
    try {
      products.push({
        nom,
        section: clean_(row.section) || 'Autres articles',
        sizes: parseSizes(row.tailles, row.prix),
        image: imageUrl(row.image),
        note: clean_(row.note),
      });
    } catch (err) {
      errors.push(`Produits, ligne ${index + 2} (${nom}) : ${err.message}`);
    }
  });
  return { products, errors };
}

/**
 * Tailles "6-8 ans:25; Adulte - S" avec prix 30
 *   → [{label: '6-8 ans', price: 25}, {label: 'Adulte - S', price: 30}].
 * Tailles vides → article en taille unique au prix de base.
 */
function parseSizes(tailles, prix) {
  const basePrice = parsePrice_(prix);
  const parts = String(tailles || '').split(';').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    if (basePrice === null) throw new Error('prix manquant');
    return [{ label: ONE_SIZE, price: basePrice }];
  }
  return parts.map((part) => {
    const colon = part.lastIndexOf(':');
    const label = colon === -1 ? part : part.slice(0, colon).trim();
    const price = colon === -1 ? basePrice : parsePrice_(part.slice(colon + 1));
    if (price === null) throw new Error(`prix manquant pour la taille « ${label} »`);
    return { label, price };
  });
}

function parsePrice_(text) {
  const cleaned = String(text == null ? '' : text).replace('€', '').replace(',', '.').trim();
  if (cleaned === '') return null;
  const price = Number(cleaned);
  if (!Number.isFinite(price) || price < 0) throw new Error(`prix invalide « ${String(text).trim()} »`);
  return price;
}

/** Un lien de partage Google Drive ne s'affiche pas dans une balise <img> : on passe par la vignette. */
function imageUrl(url) {
  const value = clean_(url);
  if (!/drive\.google\.com/.test(value)) return value;
  const match = value.match(/\/d\/([\w-]+)/) || value.match(/[?&]id=([\w-]+)/);
  return match ? `https://drive.google.com/thumbnail?id=${match[1]}&sz=w800` : value;
}

// ---------- Utilitaires ----------

function clean_(value) {
  return String(value == null ? '' : value).trim();
}

function isYes_(value) {
  return /^(oui|yes|x|1|true|vrai)$/i.test(clean_(value));
}

/** "Catégorie" → "categorie", "Date clôture" → "date_cloture". */
function normalizeKey_(text) {
  return clean_(text).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}
