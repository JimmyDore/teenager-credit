import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitAmount } from '../domain/split.mjs';

const teen = (teenId, firstName, parts) => ({ teenId, firstName, parts });

test('100 € split between 5 teens × 2 parts and 5 teens × 1 part gives 13,33 € and 6,67 €', () => {
  const participants = [
    teen('a', 'Anna', 2),
    teen('b', 'Bruno', 2),
    teen('c', 'Chloé', 2),
    teen('d', 'David', 2),
    teen('e', 'Emma', 2),
    teen('f', 'Félix', 1),
    teen('g', 'Gabriel', 1),
    teen('h', 'Hugo', 1),
    teen('i', 'Inès', 1),
    teen('j', 'Jules', 1),
  ];

  const shares = splitAmount(10000, participants);

  assert.deepEqual(
    shares.map((s) => [s.teenId, s.amountCents]),
    [
      ['a', 1333], ['b', 1333], ['c', 1333], ['d', 1333], ['e', 1333],
      ['f', 667], ['g', 667], ['h', 667], ['i', 667], ['j', 667],
    ],
  );
});

test('100 € split 3 × 1 part: the leftover cent goes to the alphabetically first teen', () => {
  const shares = splitAmount(10000, [
    teen('t1', 'Zoé', 1),
    teen('t2', 'Éloïse', 1),
    teen('t3', 'Martin', 1),
  ]);

  // French collation puts "Éloïse" before "Martin" and "Zoé".
  assert.deepEqual(
    shares.map((s) => [s.teenId, s.amountCents]),
    [['t1', 3333], ['t2', 3334], ['t3', 3333]],
  );
});

test('ties on first name are broken by teen id', () => {
  const shares = splitAmount(200, [
    teen('id-b', 'Léa', 1),
    teen('id-a', 'Léa', 1),
    teen('id-c', 'Léa', 1),
  ]);

  assert.deepEqual(
    shares.map((s) => [s.teenId, s.amountCents]),
    [['id-b', 67], ['id-a', 67], ['id-c', 66]],
  );
});

test('decimal parts: 10 € with 1.5 / 1 / 1 parts gives 4,28 / 2,86 / 2,86', () => {
  const shares = splitAmount(1000, [
    teen('a', 'Anna', 1.5),
    teen('b', 'Bruno', 1),
    teen('c', 'Chloé', 1),
  ]);

  assert.deepEqual(shares, [
    { teenId: 'a', parts: 1.5, amountCents: 428 },
    { teenId: 'b', parts: 1, amountCents: 286 },
    { teenId: 'c', parts: 1, amountCents: 286 },
  ]);
});

test('two-decimal parts that are not exact in binary floating point still split cleanly', () => {
  const shares = splitAmount(10000, [teen('a', 'Anna', 0.29), teen('b', 'Bruno', 0.71)]);

  assert.deepEqual(
    shares.map((s) => s.amountCents),
    [2900, 7100],
  );
});

test('Σ shares always equals the total, and each share is within one cent of the exact value', () => {
  let seed = 42;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  const names = ['Léa', 'Tom', 'Éloïse', 'Zoé', 'Hugo', 'Inès', 'Noé', 'Lou'];

  for (let run = 0; run < 2000; run++) {
    const count = 1 + Math.floor(random() * 25);
    const totalCents = 1 + Math.floor(random() * 5_000_000);
    const participants = Array.from({ length: count }, (_, i) =>
      teen(`t${i}`, names[Math.floor(random() * names.length)], (1 + Math.floor(random() * 500)) / 100),
    );

    const shares = splitAmount(totalCents, participants);

    const sum = shares.reduce((s, x) => s + x.amountCents, 0);
    assert.equal(sum, totalCents, `run ${run}`);
    const totalParts = participants.reduce((s, p) => s + p.parts, 0);
    shares.forEach((share, i) => {
      assert.ok(Number.isInteger(share.amountCents));
      const exact = (totalCents * participants[i].parts) / totalParts;
      assert.ok(Math.abs(share.amountCents - exact) < 1 + 1e-6, `run ${run} share ${i}`);
    });
  }
});
