// State of the « Nouvelle action » form, independent of the DOM: turns what
// the admin typed into a live preview of each share and the API payload.
import { parseEurosToCents, parseParts } from './format.mjs';

/**
 * @param {{totalInput: string, rows: {teenId: string, firstName: string, checked: boolean, partsInput: string}[]}} form
 *   rows in display order; only checked rows take part.
 * @param {typeof import('../../server/domain/split.mjs').splitAmount} splitAmount
 * @returns {{
 *   totalCents: number|null,
 *   participants: {teenId: string, parts: number}[],  // valid checked rows, ready for the API
 *   invalidTeenIds: string[],                         // checked rows whose parts are invalid
 *   partsTotal: number,
 *   shares: Record<string, number>,                   // teenId → cents, empty while something is invalid
 *   sumCents: number,
 *   error: string|null,                               // first reason the form cannot be saved
 * }}
 */
export function previewAction({ totalInput, rows }, splitAmount) {
  const totalCents = parseEurosToCents(totalInput);
  const checked = rows.filter((r) => r.checked).map((r) => ({ ...r, parts: parseParts(r.partsInput) }));
  const invalid = checked.filter((r) => r.parts === null);
  const valid = checked.filter((r) => r.parts !== null);

  let error = null;
  if (totalCents === null) error = 'Saisissez un montant total valide (ex. 120 ou 45,50).';
  else if (checked.length === 0) error = 'Choisissez au moins un participant.';
  else if (invalid.length > 0) {
    error = `Nombre de parts invalide pour ${invalid[0].firstName} (positif, 2 décimales au plus).`;
  }

  const shares = {};
  if (error === null) {
    for (const share of splitAmount(totalCents, valid)) shares[share.teenId] = share.amountCents;
  }
  return {
    totalCents,
    participants: valid.map(({ teenId, parts }) => ({ teenId, parts })),
    invalidTeenIds: invalid.map((r) => r.teenId),
    partsTotal: valid.reduce((sum, r) => sum + r.parts, 0),
    shares,
    sumCents: Object.values(shares).reduce((sum, cents) => sum + cents, 0),
    error,
  };
}
