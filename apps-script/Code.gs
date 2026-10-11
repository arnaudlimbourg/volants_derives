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

// Colonnes : A Date · B N° commande · C Client ID · D Parent · E Rôle · F Téléphone · G Email
//            H Joueur · I Catégorie · J Produit · K Taille · L Quantité · M Prix unitaire · N Total ligne · O Payé
const COMMANDES_HEADERS = [
  'Date', 'N° commande', 'Client ID', 'Parent', 'Rôle', 'Téléphone', 'Email',
  'Joueur', 'Catégorie', 'Produit', 'Taille', 'Quantité', 'Prix unitaire', 'Total ligne', 'Payé',
];

const RECAP_PAR_PRODUIT = '=QUERY(Commandes!A:O, "select J, K, sum(L) where L > 0 group by J, K order by J, K '
  + 'label J \'Produit\', K \'Taille\', sum(L) \'Quantité\'", 1)';
const RECAP_PAR_FAMILLE = '=QUERY(Commandes!A:O, "select B, D, F, G, sum(N) where L > 0 group by B, D, F, G order by B '
  + 'label B \'N° commande\', D \'Parent\', F \'Téléphone\', G \'Email\', sum(N) \'Total (€)\'", 1)';

// ---------- Web app ----------

function doGet() {
  return json_(getCatalogue());
}

function json_(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------- Catalogue ----------

function getCatalogue() {
  const settings = readSettings_();
  const built = buildProducts(readTable_(SHEETS.produits));
  built.errors.forEach((message) => console.warn(message));
  return {
    settings: {
      ouvert: isYes_(settings.ouvert),
      titre: settings.titre || '',
      intro: settings.intro || '',
      dateCloture: settings.date_cloture || '',
      lienPaiement: settings.lien_paiement || '',
      messagePaiement: settings.message_paiement || '',
    },
    categories: readTable_(SHEETS.categories).map((row) => clean_(row.categorie)).filter(Boolean),
    roles: ROLES,
    products: built.products,
  };
}

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

// ---------- Accès à la feuille ----------

function spreadsheet_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name) {
  const sheet = spreadsheet_().getSheetByName(name);
  if (!sheet) throw new Error(`Onglet « ${name} » introuvable : lancez setupSheet().`);
  return sheet;
}

/** Lit un onglet en objets dont les clés sont les en-têtes normalisés. */
function readTable_(name) {
  const values = sheet_(name).getDataRange().getDisplayValues();
  const keys = values[0].map(normalizeKey_);
  return values.slice(1)
    .filter((row) => row.some((cell) => cell !== ''))
    .map((row) => Object.fromEntries(keys.map((key, i) => [key, row[i]])));
}

function readSettings_() {
  return Object.fromEntries(readTable_(SHEETS.reglages).map((row) => [normalizeKey_(row.cle), clean_(row.valeur)]));
}

// ---------- Installation ----------

/** À lancer une fois depuis l'éditeur Apps Script. Ne touche pas aux onglets déjà présents. */
function setupSheet() {
  ensureSheet_(SHEETS.produits, PRODUITS_HEADERS, SEED_PRODUCTS);
  ensureSheet_(SHEETS.categories, ['Catégorie'], SEED_CATEGORIES.map((categorie) => [categorie]));
  ensureSheet_(SHEETS.reglages, ['Clé', 'Valeur'], SEED_SETTINGS);
  ensureSheet_(SHEETS.commandes, COMMANDES_HEADERS, []);
  // Réécrites à chaque fois : après archivage de « Commandes », elles visent le nouvel onglet.
  const recap = spreadsheet_().getSheetByName(SHEETS.recap) || spreadsheet_().insertSheet(SHEETS.recap);
  recap.getRange(1, 1).setFormula(RECAP_PAR_PRODUIT);
  recap.getRange(1, 6).setFormula(RECAP_PAR_FAMILLE);
}

function ensureSheet_(name, headers, rows) {
  if (spreadsheet_().getSheetByName(name)) return;
  const sheet = spreadsheet_().insertSheet(name);
  const values = [headers].concat(rows)
    .map((row) => row.map((cell) => (typeof cell === 'string' ? text_(cell) : cell)));
  sheet.getRange(1, 1, values.length, headers.length).setValues(values);
  sheet.setFrozenRows(1);
}

// Catalogue de départ : celui du formulaire Google de 2025.
const KIDS_SMALL = ['3-4 ans', '5-6 ans', '7-8 ans', '9-11 ans', '12-13 ans'];
const KIDS_LARGE = ['6-8 ans', '8-10 ans', '10-12 ans', '12-14 ans'];
const ADULTS = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL'];
const FLIP_FLOPS = ['31-32', '33-34', '35-36', '37-38', '39-40', '41-42', '43-44', '45-46', '47-48'];
const CAMI = "3 € reversés à l'association CAMI";

const SEED_PRODUCTS = [
  ['oui', "Textile d'équipe", 'Short', 30, `${sizes_(KIDS_LARGE, 25)}; ${sizes_(adultSizes_('XS', '3XL'))}`, '', ''],
  ['oui', "Textile d'équipe", 'Sweat', 40, `${sizes_(KIDS_SMALL, 25)}; ${sizes_(adultSizes_('XS', '4XL'))}`, '', ''],
  ['oui', 'Autres textiles', 'Softshell', 60, sizes_(KIDS_LARGE.concat(adultSizes_('S', '3XL'))), '', ''],
  ['oui', 'Autres textiles', 'Doudoune', 65, `${sizes_(KIDS_LARGE, 55)}; ${sizes_(adultSizes_('S', '4XL'))}`, '', ''],
  ['oui', 'Autres textiles', 'Tee-shirt col rond bleu', 15, sizes_(KIDS_SMALL.concat(adultSizes_('XS', '5XL'))), '', ''],
  ['oui', 'Autres textiles', 'Tee-shirt col rond blanc', 15, sizes_(KIDS_SMALL.concat(adultSizes_('XS', '5XL'))), '', ''],
  ['oui', 'Autres textiles', 'Tee-shirt col V blanc', 18, sizes_(adultSizes_('S', '3XL')), '', ''],
  ['oui', 'Autres textiles', 'Tee-shirt sport bleu', 15, sizes_(KIDS_SMALL.concat(adultSizes_('XS', '3XL'))), '', ''],
  ['oui', 'Autres textiles', 'Tee-shirt sport blanc', 15, sizes_(KIDS_SMALL.concat(adultSizes_('XS', '3XL'))), '', ''],
  ['oui', 'Autres produits dérivés', 'Casquette', 25, '', '', ''],
  ['oui', 'Autres produits dérivés', 'Bonnet', 20, '', '', ''],
  ['oui', 'Autres produits dérivés', 'Sac à dos fin', 7, '', '', ''],
  ['oui', 'Autres produits dérivés', 'Claquettes bleues logo blanc', 20, sizes_(FLIP_FLOPS), '', ''],
  ['oui', 'Autres produits dérivés', 'Claquettes blanches logo bleu', 20, sizes_(FLIP_FLOPS), '', ''],
  ['oui', 'Autres produits dérivés', 'Claquettes roses logo blanc', 20, sizes_(FLIP_FLOPS.slice(0, -1)), '', ''],
  ['oui', 'Les Volants Solidaires', 'Octobre Rose blanc', 15, sizes_(ADULTS), '', CAMI],
  ['oui', 'Les Volants Solidaires', 'Octobre Rose bleu', 15, sizes_(ADULTS), '', CAMI],
  ['oui', 'Les Volants Solidaires', 'Octobre Rose rose', 15, sizes_(ADULTS), '', CAMI],
  ['oui', 'Les Volants Solidaires', 'Movember blanc', 15, sizes_(ADULTS), '', CAMI],
  ['oui', 'Les Volants Solidaires', 'Movember noir', 15, sizes_(ADULTS), '', CAMI],
  ['oui', 'Les Volants Solidaires', 'Movember gris', 15, sizes_(ADULTS), '', CAMI],
];

const SEED_CATEGORIES = ['EDG', 'U7', 'U9', 'U11', 'U13', 'U15', 'U18', 'Féminines', 'Loisirs', 'Non concerné'];

const SEED_SETTINGS = [
  ['ouvert', 'oui'],
  ['titre', 'Boutique des Français Volants'],
  ['date_cloture', '15 octobre'],
  ['intro', "Pour s'équiper aux couleurs du club, choisissez vos articles. "
    + "Pour chaque tee-shirt Volants Solidaires acheté, 3 € sont reversés à l'association CAMI."],
  ['lien_paiement', 'https://www.onparticipe.fr/c/B11D7skx'],
  ['message_paiement', "Attention : toute commande non réglée ne sera pas comptabilisée. Merci d'avance !"],
];

function sizes_(labels, price) {
  return labels.map((label) => (price === undefined ? label : `${label}:${price}`)).join('; ');
}

function adultSizes_(from, to) {
  return ADULTS.slice(ADULTS.indexOf(from), ADULTS.indexOf(to) + 1).map((size) => `Adulte - ${size}`);
}

// ---------- Utilitaires ----------

/** L'apostrophe force Sheets à garder le texte tel quel : pas de formule injectée, pas de 0 de tête perdu. */
function text_(value) {
  return value ? `'${value}` : '';
}

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
