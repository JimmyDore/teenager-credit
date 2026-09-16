import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEurosToCents,
  formatCents,
  formatSignedCents,
  formatDate,
  formatDateTime,
  todayIso,
  parseParts,
  formatParts,
  formatNumberInput,
  centsToInput,
} from '../../public/js/format.mjs';

// Intl (fr-FR) puts a no-break space (U+00A0) before the euro sign and a
// narrow no-break space (U+202F) between thousands.
const NBSP = '\u00A0';
const NNBSP = '\u202F';
const MINUS = '\u2212';

describe('parseEurosToCents', () => {
  test('accepts a decimal comma, a decimal dot or a whole number', () => {
    assert.equal(parseEurosToCents('12,50'), 1250);
    assert.equal(parseEurosToCents('12.50'), 1250);
    assert.equal(parseEurosToCents('12'), 1200);
  });

  test('pads a single decimal and tolerates spaces and the euro sign', () => {
    assert.equal(parseEurosToCents('12,5'), 1250);
    assert.equal(parseEurosToCents(' 1 234,05 € '), 123405);
    assert.equal(parseEurosToCents('0,07'), 7);
  });

  test('rejects what is not a positive amount of at most 1 000 000 € with 2 decimals', () => {
    for (const bad of ['', 'abc', '0', '0,00', '-5', '12,505', '12,', ',50', '1.234,56', '1000000,01']) {
      assert.equal(parseEurosToCents(bad), null, `"${bad}" should be rejected`);
    }
    assert.equal(parseEurosToCents('1000000'), 100_000_000);
  });
});

describe('formatCents', () => {
  test('formats cents as French euros', () => {
    assert.equal(formatCents(1250), `12,50${NBSP}€`);
    assert.equal(formatCents(0), `0,00${NBSP}€`);
    assert.equal(formatCents(123456), `1${NNBSP}234,56${NBSP}€`);
  });
});

describe('formatSignedCents', () => {
  test('always shows the sign, with a real minus sign for debits', () => {
    assert.equal(formatSignedCents(5000), `+50,00${NBSP}€`);
    assert.equal(formatSignedCents(-1000), `${MINUS}10,00${NBSP}€`);
    assert.equal(formatSignedCents(-123456), `${MINUS}1${NNBSP}234,56${NBSP}€`);
  });
});

describe('dates', () => {
  test('formatDate turns YYYY-MM-DD into dd/mm/yyyy', () => {
    assert.equal(formatDate('2026-12-14'), '14/12/2026');
    assert.equal(formatDate('2027-01-05'), '05/01/2027');
  });

  test('formatDateTime shows an ISO timestamp in local time', () => {
    // Built from local components so the test holds in any time zone.
    const iso = new Date(2026, 11, 4, 9, 7).toISOString();
    assert.equal(formatDateTime(iso), '04/12/2026 à 09h07');
  });

  test('todayIso gives the local calendar day, not the UTC one', () => {
    assert.equal(todayIso(new Date(2026, 0, 3, 23, 59)), '2026-01-03');
    assert.equal(todayIso(new Date(2026, 9, 21, 0, 1)), '2026-10-21');
  });
});

describe('parts', () => {
  test('parseParts accepts a comma or a dot and up to 2 decimals', () => {
    assert.equal(parseParts('1'), 1);
    assert.equal(parseParts('1,5'), 1.5);
    assert.equal(parseParts(' 0.25 '), 0.25);
    assert.equal(parseParts('1000'), 1000);
  });

  test('parseParts rejects anything but a positive number of at most 1000', () => {
    for (const bad of ['', 'x', '0', '0,00', '-1', '1,555', '1001', '1,', '1 000']) {
      assert.equal(parseParts(bad), null, `"${bad}" should be rejected`);
    }
  });

  test('formatParts follows French agreement: plural from 2 on', () => {
    assert.equal(formatParts(1), '1 part');
    assert.equal(formatParts(0.5), '0,5 part');
    assert.equal(formatParts(1.5), '1,5 part');
    assert.equal(formatParts(2), '2 parts');
    assert.equal(formatParts(2.25), '2,25 parts');
  });

  test('numbers are written back into inputs with a decimal comma', () => {
    assert.equal(formatNumberInput(1.5), '1,5');
    assert.equal(formatNumberInput(3), '3');
    assert.equal(centsToInput(10000), '100');
    assert.equal(centsToInput(1250), '12,50');
    assert.equal(centsToInput(1205), '12,05');
  });
});
