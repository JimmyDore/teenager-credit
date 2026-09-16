// Tiny DOM builder: every user-provided string ends up as a text node or an
// attribute value, never as HTML.

const PROPERTIES = new Set(['value', 'checked', 'disabled', 'hidden']);

/**
 * h('button', { class: 'btn', type: 'button', onclick: fn }, 'Label', otherNode)
 * Falsy props (undefined, null, false) are skipped; `true` sets an empty attribute.
 * Children may be nodes, strings, numbers, nested arrays, or null/false (skipped).
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (PROPERTIES.has(key)) el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  el.append(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

// Static, trusted SVG markup only.
const ICONS = {
  ticket:
    '<svg viewBox="0 0 64 64" aria-hidden="true"><path fill="#F6C453" d="M10 14h44a5 5 0 0 1 5 5v7a6 6 0 0 0 0 12v7a5 5 0 0 1-5 5H10a5 5 0 0 1-5-5v-7a6 6 0 0 0 0-12v-7a5 5 0 0 1 5-5z"/><path stroke="#1D5C47" stroke-width="3" stroke-dasharray="4 4" d="M23 19v26"/></svg>',
  pencil:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>',
  trash:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4h6v3"/></svg>',
};

export function icon(name) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = ICONS[name];
  return span;
}

/** Inline error paragraph, announced by screen readers when its text changes. */
export function formError(message = '') {
  return h('p', { class: 'form-error', role: 'alert' }, message);
}

export function setError(el, message) {
  if (el) el.textContent = message ?? '';
}
