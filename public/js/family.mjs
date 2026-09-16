// Family page: code form, then the family's teens with their balance and history.
import { h, icon, formError, setError } from './dom.mjs';
import { api } from './api.mjs';
import { formatCents, formatSignedCents, formatDate, formatDateTime, formatParts } from './format.mjs';

const root = document.getElementById('app');

async function start() {
  const res = await api('GET', '/api/family');
  if (res.ok) {
    renderFamily(res.data);
    return;
  }
  const config = await api('GET', '/api/config');
  const title = config.ok ? config.data.title : 'Crédit ados';
  // 401 just means "no code yet" (or a code that was replaced): no error to show.
  renderCodeForm(title, res.status === 401 ? '' : res.error);
}

function siteBar(title) {
  return h('div', { class: 'site-bar' }, icon('ticket'), h('span', {}, title));
}

function renderCodeForm(title, errorMessage = '') {
  document.title = title;
  const input = h('input', {
    id: 'code',
    name: 'code',
    class: 'code-input',
    type: 'text',
    autocomplete: 'off',
    autocapitalize: 'characters',
    autocorrect: 'off',
    spellcheck: 'false',
    enterkeyhint: 'go',
    maxlength: 20,
    required: true,
    placeholder: '6 caractères',
    'aria-describedby': 'code-help',
  });
  const errorEl = formError(errorMessage);
  const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Voir les crédits');

  async function onSubmit(event) {
    event.preventDefault();
    setError(errorEl, '');
    if (input.value.replace(/[\s-]/g, '') === '') {
      // Not sent: an empty code would only count as a failed attempt.
      setError(errorEl, 'Saisissez votre code famille.');
      input.focus();
      return;
    }
    submit.disabled = true;
    const res = await api('POST', '/api/family/session', { code: input.value });
    submit.disabled = false;
    if (!res.ok) {
      setError(errorEl, res.error);
      input.setAttribute('aria-invalid', 'true');
      input.select();
      return;
    }
    renderFamily(res.data);
    document.getElementById('family-heading')?.focus();
  }

  root.replaceChildren(
    siteBar(title),
    h(
      'main',
      { class: 'code-page' },
      h('form', { class: 'ticket code-ticket', onsubmit: onSubmit, novalidate: true },
        h('div', { class: 'ticket__stub' },
          h('h1', {}, h('label', { for: 'code' }, 'Votre code famille')),
          h('p', { class: 'lead', id: 'code-help' },
            'Saisissez le code reçu par message pour consulter les crédits de vos ados.'),
        ),
        h('div', { class: 'ticket__perf', 'aria-hidden': 'true' }),
        h('div', { class: 'ticket__body stack' }, input, errorEl, submit),
      ),
    ),
  );
  input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
  input.focus();
}

function renderFamily(view) {
  document.title = view.title;
  const hasSeveralTeens = view.teens.length > 1;

  root.replaceChildren(
    siteBar(view.title),
    h(
      'main',
      { class: 'family-page' },
      h('h1', { id: 'family-heading', tabindex: '-1' }, `Famille ${view.family.name}`),
      view.teens.length === 0
        ? h('p', { class: 'empty' }, "Aucun ado n'est encore inscrit pour votre famille.")
        : view.teens.map(teenTicket),
      hasSeveralTeens &&
        h('p', { class: 'family-total' },
          h('span', {}, 'Total famille'),
          h('span', { class: 'family-total__amount' }, formatCents(view.totalCents)),
        ),
      h('footer', { class: 'family-foot' },
        view.updatedAt && h('p', {}, `Mis à jour le ${formatDateTime(view.updatedAt)}`),
        h('button', { type: 'button', class: 'btn btn-link', onclick: changeCode }, 'Changer de code'),
      ),
    ),
  );
}

let ticketCount = 0;

function teenTicket(teen) {
  const headingId = `teen-${++ticketCount}`;
  return h(
    'article',
    { class: 'ticket', 'aria-labelledby': headingId },
    h('header', { class: 'ticket__stub' },
      h('h2', { class: 'ticket__name', id: headingId }, teen.firstName),
      h('p', { class: 'ticket__balance' },
        h('span', { class: 'visually-hidden' }, 'Solde : '),
        formatCents(teen.balanceCents),
      ),
    ),
    h('div', { class: 'ticket__perf', 'aria-hidden': 'true' }),
    h('div', { class: 'ticket__body' },
      teen.history.length === 0
        ? h('p', { class: 'history-empty' },
            `Rien pour l'instant\u00A0: les crédits de ${teen.firstName} apparaîtront ici après sa première action.`)
        : h('ul', { class: 'history', 'aria-label': `Historique de ${teen.firstName}` },
            teen.history.map(historyLine)),
    ),
  );
}

function historyLine(line) {
  const sign = line.amountCents < 0 ? 'amount--minus' : 'amount--plus';
  return h(
    'li',
    { class: 'line' },
    h('span', { class: 'line__label' }, line.label),
    h('span', { class: 'line__meta' },
      h('time', { datetime: line.date }, formatDate(line.date)),
      line.parts !== null && h('span', { class: 'pill' }, formatParts(line.parts)),
    ),
    h('span', { class: `amount ${sign}` }, formatSignedCents(line.amountCents)),
  );
}

async function changeCode(event) {
  event.currentTarget.disabled = true;
  await api('POST', '/api/family/logout');
  const config = await api('GET', '/api/config');
  renderCodeForm(config.ok ? config.data.title : document.title);
}

start();
