/**
 * Backend de la boutique des Français Volants.
 *
 * À coller dans la feuille Google du club : Extensions → Apps Script.
 * Installation et déploiement : voir SETUP.md.
 *
 * @OnlyCurrentDoc
 * Limite l'autorisation demandée à Google à cette seule feuille, au lieu de « toutes vos feuilles ».
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
const MAX_QUANTITY = 20;
const MAX_LINES = 50;
// Anti-abus : au plus 30 nouvelles commandes par tranche de 10 minutes, tous parents confondus.
// Protège la feuille et le quota d'emails si quelqu'un envoie des commandes en masse.
const RATE_LIMIT = { orders: 30, minutes: 10 };

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
  try {
    return json_(getCatalogue());
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: 'server', message: 'La boutique est momentanément indisponible, réessayez plus tard.' });
  }
}

function doPost(e) {
  let order;
  try {
    order = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'invalid', message: 'Requête invalide.' });
  }
  try {
    return json_(placeOrder(order));
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: 'server', message: 'Erreur du serveur, réessayez dans un instant.' });
  }
}

function json_(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------- Catalogue ----------

function getCatalogue() {
  const settings = readSettings_();
  // Valeurs brutes pour les produits : le format d'affichage d'une cellule ne doit pas changer un prix.
  const built = buildProducts(readTable_(SHEETS.produits, { raw: true }));
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
    // Lignes de « Produits » ignorées : visibles en ouvrant l'URL /exec du script.
    avertissements: built.errors,
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

// ---------- Commandes ----------

function placeOrder(order) {
  // Pot de miel : seul un robot remplit ce champ caché. Pas de faux succès : si l'autoremplissage
  // d'un navigateur le remplit, le parent doit savoir que sa commande n'est pas enregistrée.
  if (clean_(order.website)) {
    return { ok: false, error: 'invalid', message: "Commande refusée par le filtre anti-robots. Rechargez la page et réessayez." };
  }

  const catalogue = getCatalogue();
  if (!catalogue.settings.ouvert) return { ok: false, error: 'closed', message: 'Les commandes sont fermées.' };

  const clientId = clean_(order.clientId);
  const priced = priceOrder(order, catalogue);
  if (!clientId) priced.errors.push('Identifiant de commande manquant.');
  if (priced.errors.length) {
    return { ok: false, error: 'invalid', message: priced.errors.join(' '), errors: priced.errors };
  }
  if (priced.unavailable.length) {
    return {
      ok: false,
      error: 'unavailable',
      message: 'Certains articles ne sont plus disponibles : retirez-les du panier puis validez à nouveau.',
      unavailable: priced.unavailable,
    };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let orderNumber;
  try {
    const existing = findOrder_(clientId);
    if (existing) {
      // Commande renvoyée (double clic, réseau coupé) : on renvoie ce qui a été enregistré la première fois,
      // même si le panier a changé depuis. L'email est déjà parti à ce moment-là.
      return { ok: true, ...existing, emailSent: true, duplicate: true };
    }
    if (!takeRateLimitSlot_()) {
      return {
        ok: false,
        error: 'busy',
        message: 'Beaucoup de commandes en ce moment : votre panier est conservé, réessayez dans quelques minutes.',
      };
    }
    orderNumber = nextOrderNumber_();
    appendOrder_(orderNumber, clientId, priced);
    // Sans flush, une requête concurrente peut lire la feuille avant l'écriture et dupliquer la commande.
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  const emailSent = sendConfirmation_(orderNumber, priced, catalogue.settings);
  return { ok: true, orderNumber, lines: priced.lines, total: priced.total, emailSent };
}

/** Valide la commande et recalcule tous les prix depuis le catalogue (ceux du navigateur sont ignorés). */
function priceOrder(order, catalogue) {
  const errors = [];
  const unavailable = [];
  const input = order.parent || {};
  const parent = {
    nom: clean_(input.nom),
    role: clean_(input.role),
    telephone: clean_(input.telephone),
    email: clean_(input.email).toLowerCase(),
  };
  if (!parent.nom) errors.push('Indiquez votre nom.');
  if (ROLES.indexOf(parent.role) === -1) errors.push('Rôle invalide.');
  if (parent.telephone.replace(/\D/g, '').length < 8) errors.push('Numéro de téléphone invalide.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parent.email)) errors.push('Adresse email invalide.');

  const joueurs = (order.joueurs || [])
    .map((joueur) => ({ nom: clean_(joueur.nom), categorie: clean_(joueur.categorie) }))
    .filter((joueur) => joueur.nom);
  joueurs.forEach((joueur) => {
    if (catalogue.categories.indexOf(joueur.categorie) === -1) errors.push(`Choisissez la catégorie de ${joueur.nom}.`);
  });

  const lignes = order.lignes || [];
  if (lignes.length === 0) errors.push('Le panier est vide.');
  if (lignes.length > MAX_LINES) errors.push(`Pas plus de ${MAX_LINES} articles différents par commande.`);

  const lines = [];
  lignes.forEach((ligne) => {
    const produit = clean_(ligne.produit);
    const taille = clean_(ligne.taille);
    const nomJoueur = clean_(ligne.joueur);
    const quantite = Number(ligne.quantite);
    if (!Number.isInteger(quantite) || quantite < 1 || quantite > MAX_QUANTITY) {
      errors.push(`Quantité invalide pour ${produit}.`);
      return;
    }
    // Un joueur vide : l'article est pour le parent lui-même.
    const joueur = nomJoueur ? joueurs.find((j) => j.nom === nomJoueur) : { nom: '', categorie: '' };
    if (!joueur) {
      errors.push(`Joueur inconnu : ${nomJoueur}.`);
      return;
    }
    const product = catalogue.products.find((p) => p.nom === produit);
    const size = product && product.sizes.find((s) => s.label === taille);
    if (!size) {
      unavailable.push({ produit, taille });
      return;
    }
    lines.push({
      joueur: joueur.nom,
      categorie: joueur.categorie,
      produit,
      taille,
      quantite,
      prixUnitaire: size.price,
      total: size.price * quantite,
    });
  });

  const total = lines.reduce((sum, line) => sum + line.total, 0);
  return { parent, joueurs, lines, total, errors, unavailable };
}

/** La commande déjà enregistrée sous ce clientId, telle qu'elle est dans la feuille. */
function findOrder_(clientId) {
  const rows = orderRows_(sheet_(SHEETS.commandes)).filter((row) => String(row[2]) === clientId);
  if (rows.length === 0) return null;
  const lines = rows.map((row) => ({
    joueur: String(row[7]),
    categorie: String(row[8]),
    produit: String(row[9]),
    taille: String(row[10]),
    quantite: Number(row[11]),
    prixUnitaire: Number(row[12]),
    total: Number(row[13]),
  }));
  const total = lines.reduce((sum, line) => sum + line.total, 0);
  return { orderNumber: String(rows[0][1]), lines, total };
}

/** Compte une commande dans la tranche de 10 minutes en cours ; false si la limite est atteinte. */
function takeRateLimitSlot_() {
  const cache = CacheService.getScriptCache();
  const windowMs = RATE_LIMIT.minutes * 60 * 1000;
  const key = `commandes_${Math.floor(Date.now() / windowMs)}`;
  const count = Number(cache.get(key) || 0);
  if (count >= RATE_LIMIT.orders) return false;
  cache.put(key, String(count + 1), RATE_LIMIT.minutes * 60 * 2);
  return true;
}

/** Compteur dans les propriétés du script : il continue même quand « Commandes » est archivé. */
function nextOrderNumber_() {
  const properties = PropertiesService.getScriptProperties();
  const next = Number(properties.getProperty('dernier_numero') || 0) + 1;
  properties.setProperty('dernier_numero', String(next));
  return `V-${String(next).padStart(4, '0')}`;
}

function appendOrder_(orderNumber, clientId, priced) {
  const sheet = sheet_(SHEETS.commandes);
  const now = new Date();
  const parent = priced.parent;
  const rows = priced.lines.map((line) => [
    now, orderNumber, text_(clientId),
    text_(parent.nom), text_(parent.role), text_(parent.telephone), text_(parent.email),
    text_(line.joueur), text_(line.categorie), text_(line.produit), text_(line.taille),
    line.quantite, line.prixUnitaire, line.total,
  ]);
  const firstRow = orderRows_(sheet).length + 2;
  // Colonnes A à N seulement : « Payé » (O) appartient au trésorier, on n'y écrit jamais.
  sheet.getRange(firstRow, 1, rows.length, rows[0].length).setValues(rows);
}

/**
 * Lignes de commande, sans l'en-tête, jusqu'au dernier N° de commande (colonne B).
 * On ne se fie pas à getLastRow() : des cases à cocher dans « Payé » comptent comme des valeurs.
 */
function orderRows_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const rows = sheet.getRange(2, 1, lastRow - 1, COMMANDES_HEADERS.length).getValues();
  let end = rows.length;
  while (end > 0 && rows[end - 1][1] === '') end -= 1;
  return rows.slice(0, end);
}

// ---------- Email de confirmation ----------

function sendConfirmation_(orderNumber, priced, settings) {
  const titre = settings.titre || 'Boutique du club';
  try {
    MailApp.sendEmail({
      to: priced.parent.email,
      subject: `${titre} : commande ${orderNumber}`,
      htmlBody: confirmationHtml(orderNumber, priced, settings),
      name: titre,
    });
    return true;
  } catch (err) {
    console.error(`Email non envoyé pour ${orderNumber} : ${err}`);
    return false;
  }
}

function confirmationHtml(orderNumber, priced, settings) {
  const groups = {};
  priced.lines.forEach((line) => {
    (groups[line.joueur] = groups[line.joueur] || []).push(line);
  });
  const sections = Object.keys(groups).map((joueur) => {
    const lines = groups[joueur];
    const heading = joueur ? `${escape_(joueur)} (${escape_(lines[0].categorie)})` : 'Pour moi';
    const rows = lines.map((line) => {
      const taille = line.taille === ONE_SIZE ? '' : ` (${escape_(line.taille)})`;
      return `<tr><td>${line.quantite} × ${escape_(line.produit)}${taille}</td>`
        + `<td align="right">${euros_(line.total)}</td></tr>`;
    }).join('');
    return `<h3 style="margin:16px 0 4px">${heading}</h3><table cellpadding="4" width="100%">${rows}</table>`;
  }).join('');
  const payment = settings.lienPaiement
    ? `<p><a href="${escape_(settings.lienPaiement)}" style="display:inline-block;padding:12px 20px;background:#12357a;`
      + 'color:#fff;border-radius:8px;text-decoration:none;font-weight:bold">Régler ma commande</a></p>'
    : '';
  const warning = settings.messagePaiement ? `<p>${escape_(settings.messagePaiement)}</p>` : '';
  return `<div style="font-family:sans-serif;max-width:560px">
<p>Bonjour ${escape_(priced.parent.nom)},</p>
<p>Nous avons bien reçu votre commande <strong>${orderNumber}</strong>.</p>
${sections}
<p style="font-size:18px"><strong>Total : ${euros_(priced.total)}</strong></p>
${payment}
${warning}
</div>`;
}

function escape_(value) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => entities[c]);
}

function euros_(amount) {
  return `${Number.isInteger(amount) ? amount : amount.toFixed(2).replace('.', ',')} €`;
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
function readTable_(name, options) {
  const range = sheet_(name).getDataRange();
  const values = options && options.raw ? range.getValues() : range.getDisplayValues();
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
