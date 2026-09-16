// Admin page: login, then Familles / Fiche ado / Actions. Every mutation
// refetches /api/admin/state and re-renders the current view.
//
// Routes (hash): #familles, #ado/<teenId>, #actions, #actions/nouvelle, #actions/<actionId>
import { splitAmount } from '/shared/split.mjs';
import { h, icon, formError, setError } from './dom.mjs';
import { api } from './api.mjs';
import {
  formatCents,
  formatSignedCents,
  formatDate,
  formatParts,
  formatNumberInput,
  centsToInput,
  parseEurosToCents,
  todayIso,
} from './format.mjs';
import { previewAction } from './action-form.mjs';

const root = document.getElementById('app');
const dialog = document.getElementById('dialog');
const toastEl = document.getElementById('toast');

let state = null; // last GET /api/admin/state, null when logged out
let appTitle = 'Crédit ados';
let movementKind = null; // 'credit' | 'debit' while the movement form is open on a teen page
let focusAfterRender = null; // CSS selector of the element to focus after the next render

// ---- Data -------------------------------------------------------------------

async function refresh() {
  const res = await api('GET', '/api/admin/state');
  if (res.ok) {
    state = res.data;
    appTitle = state.title;
    render();
  } else if (res.status === 401) {
    renderLogin();
  } else {
    root.replaceChildren(
      h('main', { class: 'login-page stack' },
        h('h1', {}, 'Administration'),
        formError(res.error),
        h('button', { type: 'button', class: 'btn btn-primary', onclick: refresh }, 'Réessayer')),
    );
  }
  return res;
}

/**
 * Runs a mutation, shows its error in `errorEl`, and on success calls
 * `onSuccess(data)` then refetches the state and re-renders.
 */
async function mutate({ method, url, body, errorEl, submitter, onSuccess }) {
  setError(errorEl, '');
  if (submitter) submitter.disabled = true;
  const res = await api(method, url, body);
  if (submitter) submitter.disabled = false;
  if (res.status === 401) {
    if (dialog.open) dialog.close();
    renderLogin('Session expirée, veuillez vous reconnecter.');
    return res;
  }
  if (!res.ok) {
    setError(errorEl, res.error);
    return res;
  }
  onSuccess?.(res.data);
  await refresh();
  return res;
}

function findTeen(teenId) {
  for (const family of state.families) {
    const teen = family.teens.find((t) => t.id === teenId);
    if (teen) return { family, teen };
  }
  return null;
}

// ---- Shell ------------------------------------------------------------------

function currentRoute() {
  const [name, id = null] = location.hash.replace(/^#\/?/, '').split('/');
  if (name === 'ado' && id) return { name: 'teen', id };
  if (name === 'actions') return { name: 'actions', id };
  return { name: 'families', id: null };
}

function render() {
  if (!state) return;
  const route = currentRoute();
  document.title = `Administration – ${state.title}`;
  const content =
    route.name === 'teen' ? renderTeen(route.id) : route.name === 'actions' ? renderActions(route.id) : renderFamilies();
  const activeTab = route.name === 'actions' ? 'actions' : 'families';

  root.replaceChildren(
    h('header', { class: 'admin-header' },
      h('h1', {}, icon('ticket'), h('span', {}, state.title), h('span', { class: 'badge' }, 'admin')),
      h('div', { class: 'button-row' },
        h('a', { class: 'btn btn-secondary btn-small', href: '/api/admin/export.csv', download: true }, 'Exporter (CSV)'),
        h('button', { type: 'button', class: 'btn btn-link', onclick: logout }, 'Se déconnecter'),
      ),
    ),
    h('nav', { class: 'tabs', 'aria-label': 'Sections' },
      tab('#familles', 'Familles', activeTab === 'families'),
      tab('#actions', 'Actions', activeTab === 'actions'),
    ),
    h('main', { class: 'admin-main', id: 'main' }, content),
  );

  if (focusAfterRender) {
    root.querySelector(focusAfterRender)?.focus();
    focusAfterRender = null;
  }
}

function tab(href, label, active) {
  return h('a', { class: 'tab', href, 'aria-current': active ? 'page' : null }, label);
}

let toastTimer;
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('is-visible'), 3500);
}

async function logout() {
  await api('POST', '/api/admin/logout');
  renderLogin();
}

// ---- Login ------------------------------------------------------------------

function renderLogin(message = '') {
  state = null;
  document.title = `Administration – ${appTitle}`;
  const input = h('input', { id: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const errorEl = formError(message);
  const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Se connecter');

  async function onSubmit(event) {
    event.preventDefault();
    setError(errorEl, '');
    submit.disabled = true;
    const res = await api('POST', '/api/admin/login', { password: input.value });
    submit.disabled = false;
    if (!res.ok) {
      setError(errorEl, res.error);
      input.select();
      return;
    }
    await refresh();
  }

  root.replaceChildren(
    h('div', { class: 'site-bar' }, icon('ticket'), h('span', {}, appTitle)),
    h('main', { class: 'login-page' },
      h('h1', {}, 'Administration'),
      h('form', { class: 'card stack', onsubmit: onSubmit },
        h('div', { class: 'field' }, h('label', { for: 'password' }, 'Mot de passe'), input),
        errorEl,
        submit,
      ),
    ),
  );
  input.focus();
}

// ---- Dialog -----------------------------------------------------------------

/**
 * In-page confirmation (never window.confirm). `onConfirm(value)` returns the
 * mutation result; the dialog closes on success and shows the error otherwise.
 */
function openDialog({ title, message, field, confirmLabel, danger = false, onConfirm }) {
  const errorEl = formError();
  const input = field
    ? h('input', { id: 'dialog-input', type: 'text', value: field.value, required: true, maxlength: 100, autocomplete: 'off' })
    : null;
  const confirm = h('button', { type: 'submit', class: danger ? 'btn btn-danger-solid' : 'btn btn-primary' }, confirmLabel);

  async function onSubmit(event) {
    event.preventDefault();
    const res = await onConfirm(input?.value, { errorEl, submitter: confirm });
    if (res?.ok) dialog.close();
  }

  dialog.replaceChildren(
    h('form', { class: 'dialog-form', onsubmit: onSubmit },
      h('h2', { id: 'dialog-title' }, title),
      message && h('p', {}, message),
      field && h('div', { class: 'field' }, h('label', { for: 'dialog-input' }, field.label), input),
      errorEl,
      h('div', { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'btn btn-secondary', onclick: () => dialog.close() }, 'Annuler'),
        confirm,
      ),
    ),
  );
  dialog.setAttribute('aria-labelledby', 'dialog-title');
  dialog.showModal();
  if (input) input.select();
  else dialog.querySelector('.btn-secondary').focus();
}

// ---- Familles ---------------------------------------------------------------

function renderFamilies() {
  const nameInput = h('input', { id: 'new-family', type: 'text', required: true, maxlength: 100, autocomplete: 'off' });
  const errorEl = formError();

  const createForm = h(
    'form',
    {
      class: 'card stack',
      onsubmit: (event) => {
        event.preventDefault();
        mutate({
          method: 'POST',
          url: '/api/admin/families',
          body: { name: nameInput.value },
          errorEl,
          submitter: event.submitter,
          onSuccess: (family) => {
            focusAfterRender = `#add-teen-${family.id}`;
            toast(`Famille ${family.name} créée. Ajoutez maintenant ses ados.`);
          },
        });
      },
    },
    h('div', { class: 'field' },
      h('label', { for: 'new-family' }, 'Nouvelle famille'),
      h('div', { class: 'inline-form__row' },
        nameInput,
        h('button', { type: 'submit', class: 'btn btn-primary' }, 'Créer'),
      ),
      h('span', { class: 'hint' }, 'Nom de famille uniquement. Un code est généré automatiquement.'),
    ),
    errorEl,
  );

  return [
    h('h2', { class: 'visually-hidden' }, 'Familles'),
    createForm,
    state.families.length === 0
      ? h('p', { class: 'empty' }, 'Aucune famille pour le moment. Créez la première ci-dessus.')
      : h('ul', { class: 'family-list' }, state.families.map((family) => h('li', {}, familyCard(family)))),
  ];
}

function familyCard(family) {
  const copyStatus = h('span', { class: 'copy-status', role: 'status' });
  const fallback = h('textarea', {
    class: 'share-fallback',
    readonly: true,
    rows: 3,
    hidden: true,
    'aria-label': `Message pour la famille ${family.name}`,
  });
  fallback.value = family.shareMessage;

  const teenInput = h('input', {
    id: `add-teen-${family.id}`,
    type: 'text',
    required: true,
    maxlength: 100,
    autocomplete: 'off',
    placeholder: 'Prénom',
  });
  const teenError = formError();

  const headingId = `family-${family.id}`;
  const someDeletable = family.teens.some((t) => t.deletable);
  return h(
    'article',
    { class: 'card family-card', 'aria-labelledby': headingId },
    h('header', { class: 'family-card__head' },
      h('h3', { id: headingId }, family.name),
      h('span', { class: 'amount' }, h('span', { class: 'visually-hidden' }, 'Total : '), formatCents(family.totalCents)),
    ),
    h('p', { class: 'family-card__code' }, 'Code', h('span', { class: 'code' }, family.code)),
    h('div', { class: 'button-row' },
      h('button', {
        type: 'button',
        class: 'btn btn-primary btn-small',
        onclick: () => copyShareMessage(family, copyStatus, fallback),
      }, 'Copier le message'),
      h('button', {
        type: 'button',
        class: 'btn btn-secondary btn-small',
        onclick: () => confirmRegenerateCode(family),
      }, 'Nouveau code'),
      copyStatus,
    ),
    fallback,
    h('ul', { class: 'teen-list', 'aria-label': `Ados de la famille ${family.name}` },
      family.teens.map((teen) =>
        h('li', { class: 'teen-row' },
          h('a', { class: 'teen-row__open', href: `#ado/${teen.id}` },
            h('span', { class: 'teen-row__name' }, teen.firstName),
            h('span', { class: 'amount' }, formatCents(teen.balanceCents)),
            h('span', { class: 'teen-row__chevron', 'aria-hidden': 'true' }, '›'),
          ),
          h('button', {
            type: 'button',
            class: 'btn btn-icon',
            'aria-label': `Renommer ${teen.firstName}`,
            title: 'Renommer',
            onclick: () => renameTeen(teen),
          }, icon('pencil')),
          teen.deletable
            ? h('button', {
                type: 'button',
                class: 'btn btn-icon is-danger',
                'aria-label': `Supprimer ${teen.firstName}`,
                title: 'Supprimer',
                onclick: () => confirmDeleteTeen(teen),
              }, icon('trash'))
            : someDeletable && h('span', { class: 'btn-icon-spacer', 'aria-hidden': 'true' }),
        ),
      ),
    ),
    h('form', {
      class: 'stack',
      onsubmit: (event) => {
        event.preventDefault();
        mutate({
          method: 'POST',
          url: `/api/admin/families/${family.id}/teens`,
          body: { firstName: teenInput.value },
          errorEl: teenError,
          submitter: event.submitter,
          onSuccess: (teen) => {
            focusAfterRender = `#add-teen-${family.id}`;
            toast(`${teen.firstName} ajouté(e) à la famille ${family.name}.`);
          },
        });
      },
    },
      h('label', { class: 'visually-hidden', for: teenInput.id }, `Prénom du nouvel ado de la famille ${family.name}`),
      h('div', { class: 'inline-form__row' },
        teenInput,
        h('button', { type: 'submit', class: 'btn btn-secondary' }, 'Ajouter'),
      ),
      teenError,
    ),
    h('div', { class: 'button-row family-card__manage' },
      h('button', { type: 'button', class: 'btn btn-link', onclick: () => renameFamily(family) }, 'Renommer la famille'),
      family.deletable &&
        h('button', {
          type: 'button',
          class: 'btn btn-link is-danger',
          onclick: () => confirmDeleteFamily(family),
        }, 'Supprimer la famille'),
    ),
  );
}

async function copyShareMessage(family, status, fallback) {
  let copied = false;
  try {
    await navigator.clipboard.writeText(family.shareMessage);
    copied = true;
  } catch {
    // Clipboard API unavailable (http, permissions): select the text instead.
    fallback.hidden = false;
    fallback.focus();
    fallback.select();
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
  }
  status.textContent = copied ? 'Copié\u00A0!' : 'Message sélectionné\u00A0: copiez-le (appui long ou Ctrl+C).';
  clearTimeout(status.clearTimer);
  if (copied) status.clearTimer = setTimeout(() => (status.textContent = ''), 3000);
}

function renameFamily(family) {
  openDialog({
    title: 'Renommer la famille',
    field: { label: 'Nom de famille', value: family.name },
    confirmLabel: 'Renommer',
    onConfirm: (name, { errorEl, submitter }) =>
      mutate({ method: 'PATCH', url: `/api/admin/families/${family.id}`, body: { name }, errorEl, submitter }),
  });
}

function confirmRegenerateCode(family) {
  openDialog({
    title: 'Générer un nouveau code\u00A0?',
    message: `L'ancien code ${family.code} de la famille ${family.name} cessera immédiatement de fonctionner. Pensez à leur envoyer le nouveau message.`,
    confirmLabel: 'Générer un nouveau code',
    onConfirm: (_, { errorEl, submitter }) =>
      mutate({
        method: 'POST',
        url: `/api/admin/families/${family.id}/regenerate-code`,
        errorEl,
        submitter,
        onSuccess: (updated) => toast(`Nouveau code de la famille ${updated.name}\u00A0: ${updated.code}`),
      }),
  });
}

function confirmDeleteFamily(family) {
  const names = joinFrench(family.teens.map((t) => t.firstName));
  openDialog({
    title: `Supprimer la famille ${family.name}\u00A0?`,
    message:
      family.teens.length === 0
        ? 'Cette famille sera définitivement supprimée.'
        : `La famille et ${family.teens.length > 1 ? 'ses ados' : 'son ado'} (${names}) seront définitivement supprimés.`,
    confirmLabel: 'Supprimer',
    danger: true,
    onConfirm: (_, { errorEl, submitter }) =>
      mutate({
        method: 'DELETE',
        url: `/api/admin/families/${family.id}`,
        errorEl,
        submitter,
        onSuccess: () => toast(`Famille ${family.name} supprimée.`),
      }),
  });
}

function renameTeen(teen) {
  openDialog({
    title: `Renommer ${teen.firstName}`,
    field: { label: 'Prénom', value: teen.firstName },
    confirmLabel: 'Renommer',
    onConfirm: (firstName, { errorEl, submitter }) =>
      mutate({ method: 'PATCH', url: `/api/admin/teens/${teen.id}`, body: { firstName }, errorEl, submitter }),
  });
}

function confirmDeleteTeen(teen) {
  openDialog({
    title: `Supprimer ${teen.firstName}\u00A0?`,
    message: `${teen.firstName} n'a encore aucun crédit ni mouvement. Cette suppression est définitive.`,
    confirmLabel: 'Supprimer',
    danger: true,
    onConfirm: (_, { errorEl, submitter }) =>
      mutate({
        method: 'DELETE',
        url: `/api/admin/teens/${teen.id}`,
        errorEl,
        submitter,
        onSuccess: () => toast(`${teen.firstName} supprimé(e).`),
      }),
  });
}

function joinFrench(items) {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} et ${items.at(-1)}`;
}

// ---- Fiche ado ----------------------------------------------------------------

function renderTeen(teenId) {
  const found = findTeen(teenId);
  const back = h('a', { class: 'back-link', href: '#familles' }, '‹ Toutes les familles');
  if (!found) return [back, h('p', { class: 'empty' }, "Cet ado n'existe plus.")];
  const { family, teen } = found;

  const toggle = (kind, label) =>
    h('button', {
      type: 'button',
      class: 'btn btn-secondary',
      'aria-expanded': String(movementKind === kind),
      'aria-controls': 'movement-form',
      onclick: () => {
        movementKind = movementKind === kind ? null : kind;
        focusAfterRender = movementKind ? '#movement-label' : null;
        render();
      },
    }, label);

  return [
    back,
    h('article', { class: 'ticket ticket--admin', 'aria-labelledby': 'teen-name' },
      h('header', { class: 'ticket__stub' },
        h('div', { class: 'teen-head' },
          h('h2', { class: 'ticket__name', id: 'teen-name' }, teen.firstName),
          h('p', {}, `Famille ${family.name}`),
        ),
        h('p', { class: 'ticket__balance' }, h('span', { class: 'visually-hidden' }, 'Solde : '), formatCents(teen.balanceCents)),
      ),
      h('div', { class: 'ticket__perf', 'aria-hidden': 'true' }),
      h('div', { class: 'ticket__body stack' },
        h('div', { class: 'button-row toggle-row' }, toggle('credit', '+ Ajouter'), toggle('debit', '− Déduire')),
        movementKind && movementForm(teen, movementKind),
        h('h3', { class: 'section-title' }, 'Historique'),
        teen.history.length === 0
          ? h('p', { class: 'history-empty' }, `Aucun crédit ni mouvement pour ${teen.firstName}.`)
          : h('ul', { class: 'history' }, teen.history.map((line) => adminHistoryLine(line, teen))),
      ),
    ),
  ];
}

function movementForm(teen, kind) {
  const isDebit = kind === 'debit';
  const label = h('input', {
    id: 'movement-label',
    type: 'text',
    required: true,
    maxlength: 100,
    autocomplete: 'off',
    placeholder: isDebit ? 'ex. Déduit facture camp' : 'ex. Report saison précédente',
  });
  const amount = h('input', {
    id: 'movement-amount',
    type: 'text',
    inputmode: 'decimal',
    required: true,
    autocomplete: 'off',
    placeholder: 'ex. 12,50',
  });
  const date = h('input', { id: 'movement-date', type: 'date', required: true, value: todayIso() });
  const errorEl = formError();
  amount.addEventListener('input', () => amount.removeAttribute('aria-invalid'));

  async function onSubmit(event) {
    event.preventDefault();
    const amountCents = parseEurosToCents(amount.value);
    if (amountCents === null) {
      amount.setAttribute('aria-invalid', 'true');
      setError(errorEl, 'Montant invalide\u00A0: saisissez un montant positif en euros, par exemple 12,50.');
      amount.focus();
      return;
    }
    await mutate({
      method: 'POST',
      url: '/api/admin/movements',
      body: { teenId: teen.id, kind, label: label.value, date: date.value, amountCents },
      errorEl,
      submitter: event.submitter,
      onSuccess: () => {
        movementKind = null;
        toast(isDebit ? `Déduction de ${formatCents(amountCents)} enregistrée.` : `Ajout de ${formatCents(amountCents)} enregistré.`);
      },
    });
  }

  return h(
    'form',
    { id: 'movement-form', class: 'movement-form stack', onsubmit: onSubmit },
    h('h3', {}, isDebit ? `Déduire du crédit de ${teen.firstName}` : `Ajouter au crédit de ${teen.firstName}`),
    h('div', { class: 'field' }, h('label', { for: label.id }, 'Libellé'), label),
    h('div', { class: 'two-cols' },
      h('div', { class: 'field' }, h('label', { for: amount.id }, 'Montant (€)'), amount),
      h('div', { class: 'field' }, h('label', { for: date.id }, 'Date'), date),
    ),
    errorEl,
    h('div', { class: 'button-row' },
      h('button', { type: 'submit', class: 'btn btn-primary' }, isDebit ? 'Déduire' : 'Ajouter'),
      h('button', {
        type: 'button',
        class: 'btn btn-secondary',
        onclick: () => {
          movementKind = null;
          render();
        },
      }, 'Annuler'),
    ),
  );
}

const LINE_KINDS = { action: 'Action', credit: 'Ajout', debit: 'Déduction' };

function adminHistoryLine(line, teen) {
  const isAction = line.type === 'action';
  return h(
    'li',
    { class: 'line' },
    h('span', { class: 'line__label' }, line.label),
    h('span', { class: 'line__meta' },
      h('time', { datetime: line.date }, formatDate(line.date)),
      h('span', { class: 'pill' }, LINE_KINDS[line.type]),
      isAction && h('span', {}, formatParts(line.parts)),
    ),
    h('span', { class: `amount ${line.amountCents < 0 ? 'amount--minus' : 'amount--plus'}` }, formatSignedCents(line.amountCents)),
    h('div', { class: 'line__controls' },
      isAction
        ? h('a', { class: 'btn btn-link', href: `#actions/${line.id}` }, "Modifier l'action")
        : h('button', {
            type: 'button',
            class: 'btn btn-link is-danger',
            onclick: () => confirmDeleteMovement(line, teen),
          }, 'Supprimer'),
    ),
  );
}

function confirmDeleteMovement(line, teen) {
  openDialog({
    title: 'Supprimer ce mouvement\u00A0?',
    message: `«\u00A0${line.label}\u00A0» du ${formatDate(line.date)} (${formatSignedCents(line.amountCents)}) sera retiré de l'historique de ${teen.firstName}.`,
    confirmLabel: 'Supprimer',
    danger: true,
    onConfirm: (_, { errorEl, submitter }) =>
      mutate({
        method: 'DELETE',
        url: `/api/admin/movements/${line.id}`,
        errorEl,
        submitter,
        onSuccess: () => toast('Mouvement supprimé.'),
      }),
  });
}

// ---- Actions ----------------------------------------------------------------

function renderActions(routeId) {
  const editing = routeId && routeId !== 'nouvelle' ? state.actions.find((a) => a.id === routeId) : null;
  const formOpen = routeId === 'nouvelle' || Boolean(editing);

  let top;
  if (routeId && routeId !== 'nouvelle' && !editing) {
    top = h('p', { class: 'empty' }, "Cette action n'existe plus. ", h('a', { href: '#actions' }, 'Retour aux actions'));
  } else if (formOpen) {
    top = actionForm(editing);
  } else {
    top = h('a', { class: 'btn btn-primary btn-block', href: '#actions/nouvelle' }, 'Nouvelle action');
  }

  return [
    h('h2', { class: 'visually-hidden' }, 'Actions'),
    top,
    h('h2', { class: 'section-title' }, 'Actions enregistrées'),
    state.actions.length === 0
      ? h('p', { class: 'empty' }, 'Aucune action pour le moment.')
      : h('ul', { class: 'action-list' }, state.actions.map((action) => actionItem(action, editing?.id === action.id))),
  ];
}

function actionItem(action, isEditing) {
  const count = action.participants.length;
  return h(
    'li',
    { class: `card action-item${isEditing ? ' is-editing' : ''}` },
    h('div', {},
      h('h3', { class: 'action-item__label' }, action.label),
      h('p', { class: 'action-item__meta' },
        h('time', { datetime: action.date }, formatDate(action.date)),
        h('span', {}, `${count} participant${count > 1 ? 's' : ''}`),
      ),
    ),
    h('span', { class: 'amount action-item__total' }, formatCents(action.totalCents)),
    h('div', { class: 'button-row' },
      h('a', { class: 'btn btn-secondary btn-small', href: `#actions/${action.id}` }, 'Modifier'),
      h('button', { type: 'button', class: 'btn btn-danger btn-small', onclick: () => confirmDeleteAction(action) }, 'Supprimer'),
    ),
  );
}

function confirmDeleteAction(action) {
  const count = action.participants.length;
  openDialog({
    title: `Supprimer «\u00A0${action.label}\u00A0»\u00A0?`,
    message: `Les crédits de cette action (${formatCents(action.totalCents)}) seront retirés ${count > 1 ? `aux ${count} participants` : 'au participant'}.`,
    confirmLabel: 'Supprimer',
    danger: true,
    onConfirm: (_, { errorEl, submitter }) =>
      mutate({
        method: 'DELETE',
        url: `/api/admin/actions/${action.id}`,
        errorEl,
        submitter,
        onSuccess: () => {
          if (currentRoute().id === action.id) history.replaceState(null, '', '#actions');
          toast(`Action «\u00A0${action.label}\u00A0» supprimée.`);
        },
      }),
  });
}

function actionForm(action) {
  const isEdit = Boolean(action);
  const selectedParts = new Map((action?.participants ?? []).map((p) => [p.teenId, p.parts]));

  const label = h('input', {
    id: 'action-label',
    type: 'text',
    required: true,
    maxlength: 100,
    autocomplete: 'off',
    value: action?.label ?? '',
    placeholder: 'ex. Vente de gâteaux',
  });
  const date = h('input', { id: 'action-date', type: 'date', required: true, value: action?.date ?? todayIso() });
  const total = h('input', {
    id: 'action-total',
    type: 'text',
    inputmode: 'decimal',
    required: true,
    autocomplete: 'off',
    value: action ? centsToInput(action.totalCents) : '',
    placeholder: 'ex. 120 ou 45,50',
  });
  const errorEl = formError();
  const summary = h('div', { class: 'preview-summary', 'aria-live': 'polite' });

  const rows = [];
  const groups = state.families
    .filter((family) => family.teens.length > 0)
    .map((family) =>
      h('div', { class: 'participant-group', role: 'group', 'aria-labelledby': `group-${family.id}` },
        h('h3', { class: 'participant-group__title', id: `group-${family.id}` }, family.name),
        family.teens.map((teen) => {
          const checkbox = h('input', { type: 'checkbox', id: `take-${teen.id}`, checked: selectedParts.has(teen.id) });
          const parts = h('input', {
            id: `parts-${teen.id}`,
            type: 'text',
            class: 'parts-input',
            inputmode: 'decimal',
            autocomplete: 'off',
            value: selectedParts.has(teen.id) ? formatNumberInput(selectedParts.get(teen.id)) : '1',
          });
          const share = h('output', { class: 'share', for: `parts-${teen.id} action-total` });
          const rowEl = h('div', { class: 'participant' },
            h('label', { class: 'participant__who' }, checkbox, teen.firstName),
            h('label', { class: 'visually-hidden', for: parts.id }, `Parts de ${teen.firstName}`),
            parts,
            share,
          );
          // Typing parts for an unchecked teen means they took part.
          parts.addEventListener('input', () => {
            if (parts.value.trim() !== '') checkbox.checked = true;
          });
          rows.push({ teen, checkbox, parts, share, rowEl });
          return rowEl;
        }),
      ),
    );

  const toggleAll = h('button', { type: 'button', class: 'btn btn-link' });

  function compute() {
    return previewAction(
      {
        totalInput: total.value,
        rows: rows.map((r) => ({
          teenId: r.teen.id,
          firstName: r.teen.firstName,
          checked: r.checkbox.checked,
          partsInput: r.parts.value,
        })),
      },
      splitAmount,
    );
  }

  function updatePreview() {
    const preview = compute();
    for (const r of rows) {
      const on = r.checkbox.checked;
      r.rowEl.classList.toggle('is-off', !on);
      r.parts.setAttribute('aria-invalid', String(on && preview.invalidTeenIds.includes(r.teen.id)));
      const cents = preview.shares[r.teen.id];
      r.share.value = cents === undefined ? (on ? '—' : '') : formatCents(cents);
    }
    const allChecked = rows.length > 0 && rows.every((r) => r.checkbox.checked);
    toggleAll.textContent = allChecked ? 'Tout décocher' : 'Tout cocher';

    const checkedCount = rows.filter((r) => r.checkbox.checked).length;
    summary.classList.toggle('is-pending', preview.error !== null);
    if (preview.error === null) {
      summary.replaceChildren(
        h('span', {}, `${checkedCount} participant${checkedCount > 1 ? 's' : ''}, ${formatParts(preview.partsTotal)}`),
        h('span', {}, 'Somme ', h('strong', {}, formatCents(preview.sumCents))),
      );
    } else if (total.value.trim() === '') {
      summary.replaceChildren(h('span', {}, 'Saisissez le total pour voir la part de chacun.'));
    } else {
      summary.replaceChildren(h('span', {}, preview.error));
    }
    return preview;
  }

  toggleAll.addEventListener('click', () => {
    const check = !rows.every((r) => r.checkbox.checked);
    for (const r of rows) r.checkbox.checked = check;
    updatePreview();
  });

  async function onSubmit(event) {
    event.preventDefault();
    const preview = updatePreview();
    if (preview.error) {
      setError(errorEl, preview.error);
      return;
    }
    const labelText = label.value.trim();
    await mutate({
      method: isEdit ? 'PUT' : 'POST',
      url: isEdit ? `/api/admin/actions/${action.id}` : '/api/admin/actions',
      body: { label: label.value, date: date.value, totalCents: preview.totalCents, participants: preview.participants },
      errorEl,
      submitter: event.submitter,
      onSuccess: () => {
        history.pushState(null, '', '#actions');
        window.scrollTo(0, 0);
        toast(isEdit ? `Action «\u00A0${labelText}\u00A0» modifiée.` : `Action «\u00A0${labelText}\u00A0» enregistrée.`);
      },
    });
  }

  const form = h(
    'form',
    { class: 'card stack action-form', onsubmit: onSubmit, oninput: () => { setError(errorEl, ''); updatePreview(); } },
    h('h2', {}, isEdit ? "Modifier l'action" : 'Nouvelle action'),
    h('div', { class: 'field' }, h('label', { for: label.id }, 'Libellé'), label),
    h('div', { class: 'two-cols' },
      h('div', { class: 'field' }, h('label', { for: date.id }, 'Date'), date),
      h('div', { class: 'field' }, h('label', { for: total.id }, 'Total (€)'), total),
    ),
    rows.length === 0 && groups.length === 0
      ? h('p', { class: 'empty' }, "Ajoutez d'abord des familles et leurs ados dans l'onglet Familles.")
      : h('fieldset', { class: 'participants' },
          h('div', { class: 'participants__head' }, h('legend', {}, 'Participants'), toggleAll),
          h('div', { class: 'participant-columns', 'aria-hidden': 'true' },
            h('span', {}, ''), h('span', {}, 'Parts'), h('span', {}, 'Montant')),
          groups,
        ),
    summary,
    errorEl,
    h('div', { class: 'button-row' },
      h('button', { type: 'submit', class: 'btn btn-primary' }, isEdit ? 'Enregistrer les modifications' : "Enregistrer l'action"),
      h('a', { class: 'btn btn-secondary', href: '#actions' }, 'Annuler'),
    ),
  );
  updatePreview();
  return form;
}

// ---- Boot ---------------------------------------------------------------------

window.addEventListener('hashchange', () => {
  movementKind = null;
  if (dialog.open) dialog.close();
  render();
  window.scrollTo(0, 0);
});

async function boot() {
  const config = await api('GET', '/api/config');
  if (config.ok) appTitle = config.data.title;
  await refresh();
}

boot();
