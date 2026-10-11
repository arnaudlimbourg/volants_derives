import { loadCatalogue, sendOrder, isDemo, ShopError } from './api.js';
import {
  addLine, setQuantity, cartCount, cartTotal, groupByPlayer, renamePlayer, removePlayer,
  markUnavailable, toOrderLines, priceLabel, formatEuro, lineKey, MAX_QUANTITY, ONE_SIZE,
} from './cart.js';

const STORAGE_KEY = 'volants-commande-v1';
const $ = (selector) => document.querySelector(selector);

const state = {
  catalogue: null,
  parent: { nom: '', role: 'Parent de joueur', telephone: '', email: '' },
  joueurs: [{ nom: '', categorie: '' }],
  lines: [],
  clientId: newClientId(),
  sending: false,
};

// ---------- Utilitaires ----------

/** Crée un élément. Le texte passe toujours par des nœuds texte, jamais par innerHTML. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'class') node.className = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  return setChildren(node, ...children);
}

/** Comme replaceChildren, mais ignore null et false (replaceChildren afficherait « null »). */
function setChildren(node, ...children) {
  node.replaceChildren(...children.flat().filter((child) => child != null && child !== false));
  return node;
}

function newClientId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function save() {
  try {
    const { parent, joueurs, lines, clientId } = state;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ parent, joueurs, lines, clientId }));
  } catch {
    // Stockage indisponible (navigation privée) : la page fonctionne quand même.
  }
}

function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!saved) return;
    Object.assign(state.parent, saved.parent);
    if (Array.isArray(saved.joueurs)) state.joueurs = saved.joueurs;
    if (Array.isArray(saved.lines)) state.lines = saved.lines;
    if (saved.clientId) state.clientId = saved.clientId;
  } catch {
    // Données illisibles : on repart de zéro.
  }
}

const namedPlayers = () => state.joueurs.filter((joueur) => joueur.nom.trim());

function playerLabel(nom) {
  if (!nom) return 'Pour moi';
  const joueur = state.joueurs.find((j) => j.nom === nom);
  return joueur?.categorie ? `${nom} (${joueur.categorie})` : nom;
}

const findSize = (produit, taille) =>
  state.catalogue.products.find((p) => p.nom === produit)?.sizes.find((s) => s.label === taille);

let toastTimer;
function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 2500);
}

function showStatus(message, { retry = false, loading = false } = {}) {
  setChildren($('#status'),
    loading ? el('span', { class: 'spinner', 'aria-hidden': 'true' }) : null,
    el('p', {}, message),
    retry ? el('button', { type: 'button', class: 'button', onclick: () => location.reload() }, 'Réessayer') : null,
  );
}

// ---------- Démarrage ----------

async function start() {
  restore();
  showStatus('Chargement de la boutique…', { loading: true });
  try {
    state.catalogue = await loadCatalogue();
  } catch (err) {
    console.error(err);
    showStatus(`Impossible de charger la boutique. ${err instanceof ShopError ? err.message : 'Vérifiez votre connexion.'}`, { retry: true });
    return;
  }

  renderHeader();
  if (!state.catalogue.settings.ouvert) {
    showStatus('Les commandes sont fermées pour le moment. Rendez-vous à la prochaine session !');
    return;
  }
  $('#status').replaceChildren();

  // Le panier enregistré peut dater d'avant un changement de catalogue.
  state.lines = state.lines.map((line) => {
    const size = findSize(line.produit, line.taille);
    return size ? { ...line, prix: size.price, indisponible: false } : { ...line, indisponible: true };
  });

  renderFamily();
  renderShop();
  renderCart();
  $('#famille').hidden = false;
  $('#boutique').hidden = false;
}

function renderHeader() {
  const { titre, intro, dateCloture } = state.catalogue.settings;
  if (titre) {
    $('#titre').textContent = titre;
    document.title = titre;
  }
  $('#intro').textContent = intro;
  $('#cloture').textContent = dateCloture ? `Commandes jusqu'au ${dateCloture}` : '';
  $('#cloture').hidden = !dateCloture;
  $('#demo-banner').hidden = !isDemo();
}

// ---------- Coordonnées et joueurs ----------

function renderFamily() {
  const form = $('#famille-form');
  form.addEventListener('submit', (e) => e.preventDefault());
  form.elements.role.replaceChildren(...state.catalogue.roles.map((role) => el('option', { value: role }, role)));
  for (const field of ['nom', 'role', 'telephone', 'email']) {
    form.elements[field].value = state.parent[field] || '';
    form.elements[field].addEventListener('input', (e) => {
      state.parent[field] = e.target.value;
      save();
    });
  }
  $('#add-joueur').addEventListener('click', () => {
    state.joueurs.push({ nom: '', categorie: '' });
    save();
    renderPlayers();
    $('#joueurs').lastElementChild.querySelector('input').focus();
  });
  renderPlayers();
}

function renderPlayers() {
  const { categories } = state.catalogue;
  $('#joueurs').replaceChildren(...state.joueurs.map((joueur, index) => {
    let previousName = joueur.nom;

    const nameInput = el('input', {
      type: 'text',
      value: joueur.nom,
      required: true,
      placeholder: 'Prénom et nom',
      autocomplete: 'off',
      'aria-label': `Nom du joueur ${index + 1}`,
      // Pas de save() ici : les articles ne suivent le nouveau nom qu'au change, enregistrer avant
      // laisserait des articles orphelins si la page est rechargée en pleine saisie.
      oninput: (e) => { joueur.nom = e.target.value; },
      onchange: (e) => {
        const nom = e.target.value.trim();
        e.target.value = nom;
        joueur.nom = nom;
        let renamed = null;
        // Nom effacé : les articles restent attribués à l'ancien nom, le serveur le signalera.
        // Premier nom saisi : les articles « Pour moi » ajoutés avant le suivent, mais pas ceux
        // que le parent a choisis pour lui alors qu'un autre joueur existait déjà.
        if (nom && (previousName || namedPlayers().length === 1)) {
          state.lines = renamePlayer(state.lines, previousName, nom);
          renamed = { from: previousName, to: nom };
        }
        if (nom) previousName = nom;
        save();
        refreshPlayerSelects(renamed);
        renderCart();
      },
    });

    const categorySelect = el('select', {
      required: true,
      'aria-label': `Catégorie du joueur ${index + 1}`,
      onchange: (e) => { joueur.categorie = e.target.value; save(); refreshPlayerSelects(); renderCart(); },
    },
    el('option', { value: '' }, 'Catégorie'),
    categories.map((categorie) => el('option', { value: categorie, selected: categorie === joueur.categorie }, categorie)));

    const remove = el('button', {
      type: 'button',
      class: 'icon-button',
      'aria-label': `Retirer ${joueur.nom || `le joueur ${index + 1}`}`,
      onclick: () => {
        const count = joueur.nom ? state.lines.filter((line) => line.joueur === joueur.nom).length : 0;
        if (count && !confirm(`Retirer ${joueur.nom} et ses articles du panier ?`)) return;
        if (joueur.nom) state.lines = removePlayer(state.lines, joueur.nom);
        state.joueurs.splice(index, 1);
        save();
        renderPlayers();
        refreshPlayerSelects();
        renderCart();
      },
    }, '×');

    return el('div', { class: 'player-row' }, nameInput, categorySelect, remove);
  }));
}

function playerOptions(selected) {
  return [
    ...namedPlayers().map((j) => el('option', { value: j.nom, selected: j.nom === selected }, playerLabel(j.nom))),
    el('option', { value: '', selected: selected === '' }, 'Pour moi'),
  ];
}

function refreshPlayerSelects(renamed = null) {
  const first = namedPlayers()[0]?.nom ?? '';
  document.querySelectorAll('select[name="joueur"]').forEach((select) => {
    // Tant que le parent n'a pas choisi lui-même, on propose le premier joueur.
    const chosen = renamed && select.value === renamed.from ? renamed.to : select.value;
    select.replaceChildren(...playerOptions(select.dataset.touched ? chosen : first));
  });
}

// ---------- Articles ----------

function renderShop() {
  const sections = new Map();
  for (const product of state.catalogue.products) {
    if (!sections.has(product.section)) sections.set(product.section, []);
    sections.get(product.section).push(product);
  }
  $('#sections').replaceChildren(...[...sections].map(([title, products]) =>
    el('section', { class: 'shop-section' },
      el('h3', {}, title),
      el('div', { class: 'grid' }, products.map(productCard)))));
}

function productCard(product) {
  const single = product.sizes.length === 1;
  const price = el('p', { class: 'price' }, priceLabel(product));

  const sizeSelect = el('select', {
    name: 'taille',
    'aria-label': `Taille, ${product.nom}`,
    onchange: () => {
      const size = product.sizes.find((s) => s.label === sizeSelect.value);
      price.textContent = size ? formatEuro(size.price) : priceLabel(product);
      sizeSelect.classList.remove('invalid');
    },
  },
  el('option', { value: '' }, 'Choisir'),
  product.sizes.map((s) => el('option', { value: s.label }, `${s.label} (${formatEuro(s.price)})`)));

  const playerSelect = el('select', {
    name: 'joueur',
    'aria-label': `Pour qui, ${product.nom}`,
    onchange: (e) => { e.target.dataset.touched = 'oui'; },
  },
    playerOptions(namedPlayers()[0]?.nom ?? ''));

  const quantity = el('input', {
    type: 'number', name: 'quantite', min: 1, max: MAX_QUANTITY, value: 1, inputmode: 'numeric',
    'aria-label': `Quantité, ${product.nom}`,
  });

  const add = () => {
    const taille = single ? product.sizes[0].label : sizeSelect.value;
    if (!taille) {
      sizeSelect.classList.add('invalid');
      sizeSelect.focus();
      toast('Choisissez une taille.');
      return;
    }
    const line = { produit: product.nom, taille, joueur: playerSelect.value, quantite: Number.parseInt(quantity.value, 10) || 1 };
    line.prix = product.sizes.find((s) => s.label === taille).price;
    const key = lineKey(line);
    const before = state.lines.find((l) => lineKey(l) === key)?.quantite ?? 0;
    state.lines = addLine(state.lines, line); // addLine plafonne la quantité
    const after = state.lines.find((l) => lineKey(l) === key).quantite;
    save();
    renderCart();
    quantity.value = 1;
    toast(after < before + line.quantite
      ? `${product.nom} : ${MAX_QUANTITY} maximum, quantité ajustée à ${after}`
      : `${product.nom} ajouté au panier`);
  };

  return el('article', { class: 'product' },
    el('div', { class: 'product-image' },
      product.image
        ? el('img', { src: product.image, alt: product.nom, loading: 'lazy', onerror: (e) => e.target.remove() })
        : null),
    el('div', { class: 'product-body' },
      el('div', { class: 'product-title' }, el('h4', {}, product.nom), price),
      product.note ? el('p', { class: 'note' }, product.note) : null,
      el('div', { class: 'product-form' },
        single ? null : el('label', { class: 'full' }, 'Taille', sizeSelect),
        el('label', {}, 'Pour', playerSelect),
        el('label', {}, 'Quantité', quantity),
        el('button', { type: 'button', class: 'button primary full', onclick: add }, 'Ajouter au panier'))));
}

// ---------- Panier ----------

function renderCart() {
  const count = cartCount(state.lines);
  const total = formatEuro(cartTotal(state.lines));
  $('#cart-bar').hidden = count === 0 || !$('#confirmation').hidden;
  $('#cart-count').textContent = `${count} article${count > 1 ? 's' : ''}`;
  $('#cart-total').textContent = total;
  $('#cart-sum').textContent = total;
  $('#cart-lines').replaceChildren(...(count === 0
    ? [el('p', { class: 'hint' }, 'Votre panier est vide : ajoutez des articles depuis la boutique.')]
    : groupByPlayer(state.lines).map(({ joueur, lines }) =>
      el('section', { class: 'cart-group' }, el('h3', {}, playerLabel(joueur)), lines.map(cartLine)))));
  $('#submit').disabled = count === 0 || state.sending;
}

function cartLine(line) {
  const key = lineKey(line);
  const update = (quantite) => {
    state.lines = setQuantity(state.lines, key, quantite);
    save();
    renderCart();
  };
  return el('div', { class: `cart-line${line.indisponible ? ' unavailable' : ''}` },
    el('div', { class: 'cart-line-info' },
      el('strong', {}, line.produit),
      line.taille !== ONE_SIZE ? el('span', {}, line.taille) : null,
      line.indisponible ? el('span', { class: 'badge' }, 'Plus disponible') : null),
    el('div', { class: 'stepper' },
      el('button', { type: 'button', 'aria-label': `Retirer un ${line.produit}`, onclick: () => update(line.quantite - 1) }, '−'),
      el('span', {}, String(line.quantite)),
      el('button', {
        type: 'button',
        'aria-label': `Ajouter un ${line.produit}`,
        disabled: line.quantite >= MAX_QUANTITY,
        onclick: () => update(line.quantite + 1),
      }, '+')),
    el('span', { class: 'cart-line-price' }, formatEuro(line.prix * line.quantite)),
    el('button', {
      type: 'button',
      class: 'icon-button',
      'aria-label': `Supprimer ${line.produit} du panier`,
      onclick: () => update(0),
    }, '×'));
}

function setCartError(message) {
  $('#cart-error').textContent = message;
  $('#cart-error').hidden = !message;
}

async function submitOrder() {
  setCartError('');
  // Une ligne de joueur laissée vide (commande pour soi) ne doit pas bloquer la validation.
  const filled = state.joueurs.filter((joueur) => joueur.nom.trim() || joueur.categorie);
  if (filled.length !== state.joueurs.length) {
    state.joueurs = filled;
    save();
    renderPlayers();
  }
  const form = $('#famille-form');
  if (!form.checkValidity()) {
    $('#cart').close();
    form.reportValidity();
    return;
  }
  if (state.lines.some((line) => line.indisponible)) {
    setCartError("Retirez d'abord les articles qui ne sont plus disponibles.");
    return;
  }

  state.sending = true;
  $('#submit').textContent = 'Envoi en cours…';
  renderCart();
  try {
    const result = await sendOrder({
      clientId: state.clientId,
      website: $('#fv-piege').value,
      parent: state.parent,
      joueurs: namedPlayers(),
      lignes: toOrderLines(state.lines),
    });
    if (result.ok) {
      showConfirmation(result);
      return;
    }
    if (result.error === 'unavailable') {
      state.lines = markUnavailable(state.lines, result.unavailable);
      save();
    }
    setCartError(result.message || 'La commande a été refusée.');
  } catch (err) {
    console.error(err);
    setCartError('Connexion impossible. Votre panier est conservé : réessayez dans un instant.');
  } finally {
    state.sending = false;
    $('#submit').textContent = 'Commander';
    renderCart();
  }
}

// ---------- Confirmation ----------

function showConfirmation(result) {
  const email = state.parent.email;
  state.lines = [];
  state.clientId = newClientId();
  save();

  $('#cart').close();
  $('#toast').hidden = true;
  $('#famille').hidden = true;
  $('#boutique').hidden = true;

  const { lienPaiement, messagePaiement } = state.catalogue.settings;
  setChildren($('#confirmation'),
    el('h2', {}, 'Commande enregistrée'),
    el('p', { class: 'order-number' }, result.orderNumber),
    el('p', {}, result.emailSent
      ? `Un récapitulatif a été envoyé à ${email}.`
      : "L'email de confirmation n'a pas pu être envoyé : notez votre numéro de commande."),
    ...groupByPlayer(result.lines).map(({ joueur, lines }) =>
      el('section', { class: 'cart-group' },
        el('h3', {}, playerLabel(joueur)),
        lines.map((line) => el('div', { class: 'summary-line' },
          el('span', {}, `${line.quantite} × ${line.produit}${line.taille === ONE_SIZE ? '' : ` (${line.taille})`}`),
          el('span', {}, formatEuro(line.total)))))),
    el('p', { class: 'summary-total' }, el('span', {}, 'Total'), el('strong', {}, formatEuro(result.total))),
    lienPaiement
      ? el('a', { class: 'button primary large', href: lienPaiement, target: '_blank', rel: 'noopener' }, 'Régler ma commande')
      : null,
    messagePaiement ? el('p', { class: 'warning' }, messagePaiement) : null,
    el('button', { type: 'button', class: 'button large', onclick: () => location.reload() }, 'Passer une autre commande'),
  );
  $('#confirmation').hidden = false;
  renderCart();
  window.scrollTo({ top: 0 });
}

// ---------- Événements ----------

$('#open-cart').addEventListener('click', () => {
  setCartError('');
  $('#cart').showModal();
});
$('#close-cart').addEventListener('click', () => $('#cart').close());
$('#submit').addEventListener('click', submitOrder);

start();
