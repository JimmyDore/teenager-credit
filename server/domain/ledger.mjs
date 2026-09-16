// Domain rules of the credit ledger, as functions over the data object
// persisted in credits.json. Mutations validate everything first, then modify
// the given data in place; a broken rule throws DomainError (HTTP status +
// French message) and leaves the data untouched. Projections (family view,
// admin state, CSV) are read-only.

import { randomInt, randomUUID } from 'node:crypto';
import { splitAmount, scaleParts } from './split.mjs';

const MAX_TEXT_LENGTH = 100;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
const CODE_LENGTH = 6;
const MAX_CODE_ATTEMPTS = 1000;
// Upper bounds keep the split's integer arithmetic far below 2^53.
const MAX_AMOUNT_CENTS = 100_000_000; // 1 000 000 €
const MAX_PARTS = 1000;

export class DomainError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'DomainError';
    this.status = status;
  }
}

export function emptyData() {
  return { version: 1, families: [], teens: [], actions: [], movements: [] };
}

export function generateCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

export function normalizeCode(input) {
  return typeof input === 'string' ? input.toUpperCase().replace(/[\s\-‐‑–—]/g, '') : '';
}

export function createLedger({ now = Date.now, newId = randomUUID, newCode = generateCode } = {}) {
  const nowIso = () => new Date(now()).toISOString();

  // Applies a credit-history `patch` to `data` only if no teen's balance
  // drops below zero, and stamps the families of the touched teens.
  function commit(data, patch, touchedTeenIds) {
    const before = balances(data);
    const after = balances({ ...data, ...patch });
    const negative = data.teens.filter((t) => {
      const balance = after.get(t.id) ?? 0;
      return balance < 0 && balance < (before.get(t.id) ?? 0);
    });
    if (negative.length > 0) {
      const names = joinFrench(negative.map((t) => `${t.firstName} (${familyName(data, t)})`));
      const amounts = joinFrench(negative.map((t) => formatEuros(after.get(t.id))));
      const message =
        negative.length === 1
          ? `Opération refusée : le solde de ${names} deviendrait négatif (${amounts}).`
          : `Opération refusée : les soldes de ${names} deviendraient négatifs (respectivement ${amounts}).`;
      throw new DomainError(409, message);
    }
    Object.assign(data, patch);
    const timestamp = nowIso();
    const familyIds = new Set(data.teens.filter((t) => touchedTeenIds.includes(t.id)).map((t) => t.familyId));
    for (const family of data.families) {
      if (familyIds.has(family.id)) family.historyUpdatedAt = timestamp;
    }
  }

  function uniqueCode(data) {
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      const code = newCode();
      if (!data.families.some((f) => f.code === code)) return code;
    }
    throw new Error('Unable to generate a unique family code');
  }

  function createFamily(data, body) {
    const name = requiredText(body?.name, 'Le nom de famille');
    const family = { id: newId(), name, code: uniqueCode(data), createdAt: nowIso() };
    data.families.push(family);
    return family;
  }

  function renameFamily(data, familyId, body) {
    const family = getFamily(data, familyId);
    family.name = requiredText(body?.name, 'Le nom de famille');
    return family;
  }

  function addTeen(data, familyId, body) {
    const family = getFamily(data, familyId);
    const firstName = requiredText(body?.firstName, 'Le prénom');
    const teen = { id: newId(), familyId: family.id, firstName, createdAt: nowIso() };
    data.teens.push(teen);
    return teen;
  }

  function renameTeen(data, teenId, body) {
    const teen = getTeen(data, teenId);
    teen.firstName = requiredText(body?.firstName, 'Le prénom');
    return teen;
  }

  function deleteTeen(data, teenId) {
    const teen = getTeen(data, teenId);
    if (hasHistory(data, teen.id)) {
      throw new DomainError(409, `Impossible de supprimer ${teen.firstName} : il y a déjà des actions ou des mouvements à son nom.`);
    }
    data.teens = data.teens.filter((t) => t.id !== teen.id);
  }

  function deleteFamily(data, familyId) {
    const family = getFamily(data, familyId);
    const blocking = data.teens.filter((t) => t.familyId === family.id && hasHistory(data, t.id));
    if (blocking.length > 0) {
      const names = joinFrench(blocking.map((t) => t.firstName));
      throw new DomainError(
        409,
        `Impossible de supprimer la famille ${family.name} : il y a déjà des actions ou des mouvements au nom de ${names}.`,
      );
    }
    data.teens = data.teens.filter((t) => t.familyId !== family.id);
    data.families = data.families.filter((f) => f.id !== family.id);
  }

  function createAction(data, body) {
    const fields = actionFields(data, body);
    const timestamp = nowIso();
    const action = { id: newId(), ...fields, createdAt: timestamp, updatedAt: timestamp };
    commit(data, { actions: [...data.actions, action] }, teenIdsOf(action));
    return action;
  }

  function updateAction(data, actionId, body) {
    const existing = getAction(data, actionId);
    const updated = { ...existing, ...actionFields(data, body), updatedAt: nowIso() };
    commit(
      data,
      { actions: data.actions.map((a) => (a.id === existing.id ? updated : a)) },
      [...teenIdsOf(existing), ...teenIdsOf(updated)],
    );
    return updated;
  }

  function deleteAction(data, actionId) {
    const existing = getAction(data, actionId);
    commit(data, { actions: data.actions.filter((a) => a.id !== existing.id) }, teenIdsOf(existing));
  }

  function createMovement(data, body) {
    const teen = getTeen(data, body?.teenId);
    const kind = body?.kind;
    if (kind !== 'credit' && kind !== 'debit') {
      throw new DomainError(400, 'Type de mouvement invalide (ajout ou déduction).');
    }
    const movement = {
      id: newId(),
      teenId: teen.id,
      kind,
      label: requiredText(body?.label, 'Le libellé'),
      date: validDate(body?.date),
      amountCents: validAmount(body?.amountCents),
      createdAt: nowIso(),
    };
    commit(data, { movements: [...data.movements, movement] }, [teen.id]);
    return movement;
  }

  function deleteMovement(data, movementId) {
    const existing = data.movements.find((m) => m.id === movementId);
    if (!existing) throw new DomainError(404, 'Mouvement introuvable.');
    commit(data, { movements: data.movements.filter((m) => m.id !== existing.id) }, [existing.teenId]);
  }

  function regenerateCode(data, familyId) {
    const family = getFamily(data, familyId);
    family.code = uniqueCode(data);
    return family;
  }

  function findFamilyByCode(data, rawCode) {
    const code = normalizeCode(rawCode);
    if (!code) return null;
    return data.families.find((f) => f.code === code) ?? null;
  }

  function familyView(data, familyId) {
    const family = getFamily(data, familyId);
    const balanceOf = balances(data);
    const teens = sortByFirstName(data.teens.filter((t) => t.familyId === family.id)).map((teen) => ({
      firstName: teen.firstName,
      balanceCents: balanceOf.get(teen.id),
      history: teenHistory(data, teen.id).map(({ date, label, amountCents, parts }) => ({
        date,
        label,
        amountCents,
        parts,
      })),
    }));
    return {
      family: { name: family.name },
      teens,
      totalCents: teens.reduce((sum, t) => sum + t.balanceCents, 0),
      updatedAt: family.historyUpdatedAt ?? null,
    };
  }

  function adminState(data, { publicUrl }) {
    const balanceOf = balances(data);
    const families = [...data.families]
      .sort((a, b) => a.name.localeCompare(b.name, 'fr') || compareStrings(a.id, b.id))
      .map((family) => {
        const teens = sortByFirstName(data.teens.filter((t) => t.familyId === family.id)).map((teen) => ({
          ...teen,
          balanceCents: balanceOf.get(teen.id),
          deletable: !hasHistory(data, teen.id),
          history: teenHistory(data, teen.id),
        }));
        return {
          id: family.id,
          name: family.name,
          code: family.code,
          createdAt: family.createdAt,
          updatedAt: family.historyUpdatedAt ?? null,
          shareMessage: `Bonjour, retrouvez les crédits ados de la famille ${family.name} sur ${publicUrl} avec le code : ${family.code}`,
          totalCents: teens.reduce((sum, t) => sum + t.balanceCents, 0),
          deletable: teens.every((t) => t.deletable),
          teens,
        };
      });
    return {
      families,
      actions: mostRecentFirst(data.actions),
      movements: mostRecentFirst(data.movements),
    };
  }

  return {
    adminState,
    exportCsv,
    familyView,
    createFamily,
    renameFamily,
    regenerateCode,
    findFamilyByCode,
    deleteFamily,
    addTeen,
    renameTeen,
    deleteTeen,
    createAction,
    updateAction,
    deleteAction,
    createMovement,
    deleteMovement,
    teenBalance,
  };
}

function teenBalance(data, teenId) {
  return balances(data).get(teenId) ?? 0;
}

function balances(data) {
  const result = new Map(data.teens.map((t) => [t.id, 0]));
  const add = (teenId, cents) => result.set(teenId, (result.get(teenId) ?? 0) + cents);
  for (const action of data.actions) {
    for (const p of action.participants) add(p.teenId, p.amountCents);
  }
  for (const m of data.movements) add(m.teenId, m.kind === 'debit' ? -m.amountCents : m.amountCents);
  return result;
}

const CSV_HEADER = ['Date', 'Famille', 'Ado', 'Type', 'Libellé', 'Parts', 'Montant'];
const CSV_TYPES = { action: 'Action', credit: 'Ajout', debit: 'Déduction' };

/** UTF-8 CSV for French spreadsheets: BOM, `;` separator, decimal comma, CRLF. */
export function exportCsv(data) {
  const rows = [];
  for (const teen of data.teens) {
    const familyName = data.families.find((f) => f.id === teen.familyId)?.name ?? '';
    for (const line of teenHistory(data, teen.id)) rows.push({ ...line, familyName, firstName: teen.firstName });
  }
  rows.sort(
    (a, b) =>
      compareStrings(a.date, b.date) ||
      compareStrings(a.createdAt, b.createdAt) ||
      a.familyName.localeCompare(b.familyName, 'fr') ||
      a.firstName.localeCompare(b.firstName, 'fr'),
  );
  const lines = [CSV_HEADER, ...rows.map((r) => [
    frenchDate(r.date),
    r.familyName,
    r.firstName,
    CSV_TYPES[r.type],
    r.label,
    r.parts === null ? '' : String(r.parts).replace('.', ','),
    formatCents(r.amountCents),
  ])];
  return '\uFEFF' + lines.map((cells) => cells.map(csvCell).join(';') + '\r\n').join('');
}

function csvCell(value) {
  return /[;"\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function frenchDate(isoDate) {
  const [year, month, day] = isoDate.split('-');
  return `${day}/${month}/${year}`;
}

function mostRecentFirst(records) {
  return [...records].sort((a, b) => compareStrings(b.date, a.date) || compareStrings(b.createdAt, a.createdAt));
}

function teenIdsOf(action) {
  return action.participants.map((p) => p.teenId);
}

function sortByFirstName(teens) {
  return [...teens].sort((a, b) => a.firstName.localeCompare(b.firstName, 'fr') || compareStrings(a.id, b.id));
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Credit history lines of a teen, most recent first (date desc, then createdAt desc). */
function teenHistory(data, teenId) {
  const lines = [];
  for (const action of data.actions) {
    for (const p of action.participants) {
      if (p.teenId !== teenId) continue;
      lines.push({
        type: 'action',
        id: action.id,
        date: action.date,
        label: action.label,
        amountCents: p.amountCents,
        parts: p.parts,
        createdAt: action.createdAt,
      });
    }
  }
  for (const m of data.movements) {
    if (m.teenId !== teenId) continue;
    lines.push({
      type: m.kind,
      id: m.id,
      date: m.date,
      label: m.label,
      amountCents: m.kind === 'debit' ? -m.amountCents : m.amountCents,
      parts: null,
      createdAt: m.createdAt,
    });
  }
  return lines.sort((a, b) => compareStrings(b.date, a.date) || compareStrings(b.createdAt, a.createdAt));
}

function hasHistory(data, teenId) {
  return (
    data.movements.some((m) => m.teenId === teenId) ||
    data.actions.some((a) => a.participants.some((p) => p.teenId === teenId))
  );
}

function familyName(data, teen) {
  return data.families.find((f) => f.id === teen.familyId)?.name ?? '?';
}

function joinFrench(items) {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} et ${items.at(-1)}`;
}

/** 1333 → "13,33", -2500 → "-25,00" */
export function formatCents(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

function formatEuros(cents) {
  return `${formatCents(cents)} €`;
}

function actionFields(data, body) {
  const label = requiredText(body?.label, 'Le libellé');
  const date = validDate(body?.date);
  const totalCents = validAmount(body?.totalCents);
  const rawParticipants = body?.participants;
  if (!Array.isArray(rawParticipants) || rawParticipants.length === 0) {
    throw new DomainError(400, 'Choisissez au moins un participant.');
  }
  const seen = new Set();
  const participants = rawParticipants.map((p) => {
    const teen = data.teens.find((t) => t.id === p?.teenId);
    if (!teen) throw new DomainError(400, 'Ado inconnu parmi les participants.');
    if (seen.has(teen.id)) {
      throw new DomainError(400, `${teen.firstName} apparaît plusieurs fois parmi les participants.`);
    }
    seen.add(teen.id);
    return { teenId: teen.id, firstName: teen.firstName, parts: validParts(p.parts, teen) };
  });
  return { label, date, totalCents, participants: splitAmount(totalCents, participants) };
}

function validDate(value) {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match) {
    const [year, month, day] = match.slice(1).map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) {
      return value;
    }
  }
  throw new DomainError(400, 'Date invalide (format attendu AAAA-MM-JJ).');
}

function validAmount(value) {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_AMOUNT_CENTS) {
    throw new DomainError(400, 'Montant invalide : il doit être positif et exprimé en centimes entiers.');
  }
  return value;
}

function validParts(value, teen) {
  const valid =
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_PARTS &&
    Math.abs(value * 100 - scaleParts(value)) < 1e-6;
  if (!valid) {
    throw new DomainError(400, `Nombre de parts invalide pour ${teen.firstName} (positif, 2 décimales au plus).`);
  }
  return scaleParts(value) / 100;
}

function getFamily(data, familyId) {
  const family = data.families.find((f) => f.id === familyId);
  if (!family) throw new DomainError(404, 'Famille introuvable.');
  return family;
}

function getAction(data, actionId) {
  const action = data.actions.find((a) => a.id === actionId);
  if (!action) throw new DomainError(404, 'Action introuvable.');
  return action;
}

function getTeen(data, teenId) {
  const teen = data.teens.find((t) => t.id === teenId);
  if (!teen) throw new DomainError(404, 'Ado introuvable.');
  return teen;
}

function requiredText(value, fieldLabel) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new DomainError(400, `${fieldLabel} est obligatoire.`);
  if (text.length > MAX_TEXT_LENGTH) {
    throw new DomainError(400, `${fieldLabel} doit faire au plus ${MAX_TEXT_LENGTH} caractères.`);
  }
  return text;
}
