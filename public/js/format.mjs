// Pure formatting and parsing helpers shared by the family and admin pages.
// No DOM access here: everything is covered by test/web/format.test.mjs.

export const MAX_AMOUNT_CENTS = 100_000_000; // 1 000 000 €, same bound as the server

/** "12,50" | "12.50" | "12" | "1 234,5 €" → integer cents, or null when invalid. */
export function parseEurosToCents(input) {
  const compact = String(input ?? '').replace(/[\s€]/g, '');
  const match = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(compact);
  if (!match) return null;
  const [, euros, decimals = ''] = match;
  const cents = Number(euros) * 100 + Number(decimals.padEnd(2, '0'));
  return cents > 0 && cents <= MAX_AMOUNT_CENTS ? cents : null;
}

const euros = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });

/** 1250 → "12,50 €" */
export function formatCents(cents) {
  return euros.format(cents / 100);
}

/** 5000 → "+50,00 €", -1000 → "−10,00 €" (U+2212, as wide as the plus sign) */
export function formatSignedCents(cents) {
  if (cents < 0) return `−${formatCents(-cents)}`;
  return `+${formatCents(cents)}`;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** "2026-12-14" → "14/12/2026" */
export function formatDate(isoDate) {
  const [year, month, day] = isoDate.split('-');
  return `${day}/${month}/${year}`;
}

/** ISO timestamp → "04/12/2026 à 09h07", in the viewer's time zone */
export function formatDateTime(isoTimestamp) {
  const d = new Date(isoTimestamp);
  return `${formatDate(todayIso(d))} à ${pad2(d.getHours())}h${pad2(d.getMinutes())}`;
}

/** Local calendar day as YYYY-MM-DD (toISOString would give the UTC day). */
export function todayIso(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export const MAX_PARTS = 1000; // same bound as the server

/** "1,5" | "1.5" | "2" → 1.5 | 2, or null when not a positive number (≤ 1000, ≤ 2 decimals). */
export function parseParts(input) {
  const match = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(String(input ?? '').trim());
  if (!match) return null;
  const parts = Number(`${match[1]}.${match[2] ?? '0'}`);
  return parts > 0 && parts <= MAX_PARTS ? parts : null;
}

const decimal = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2, useGrouping: false });

/** 1.5 → "1,5" (for input values) */
export function formatNumberInput(value) {
  return decimal.format(value);
}

/** 2 → "2 parts", 1.5 → "1,5 part": in French the plural starts at 2. */
export function formatParts(parts) {
  return `${formatNumberInput(parts)} ${parts >= 2 ? 'parts' : 'part'}`;
}

/** 10000 → "100", 1250 → "12,50" (for input values) */
export function centsToInput(cents) {
  const whole = Math.floor(cents / 100);
  const rest = cents % 100;
  return rest === 0 ? String(whole) : `${whole},${pad2(rest)}`;
}
