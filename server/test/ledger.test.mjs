import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createLedger, emptyData, DomainError, generateCode, normalizeCode, formatCents } from '../domain/ledger.mjs';

const T0 = Date.parse('2026-09-16T10:00:00.000Z');

function setup({ codes } = {}) {
  let clock = T0;
  let idCounter = 0;
  let codeCounter = 0;
  const codeQueue = codes ? [...codes] : null;
  const ledger = createLedger({
    now: () => clock,
    newId: () => `id${++idCounter}`,
    newCode: () => (codeQueue ? codeQueue.shift() : `CODE${String(++codeCounter).padStart(2, '0')}`),
  });
  return {
    ledger,
    data: emptyData(),
    tick(ms = 1000) {
      clock += ms;
    },
  };
}

function assertDomainError(fn, status, messagePattern) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof DomainError, `expected DomainError, got ${err}`);
    assert.equal(err.status, status);
    if (messagePattern) assert.match(err.message, messagePattern);
    return true;
  });
}

describe('families', () => {
  test('creating a family trims its name and gives it a code', () => {
    const { ledger, data } = setup();

    const family = ledger.createFamily(data, { name: '  Martin ' });

    assert.deepEqual(family, {
      id: 'id1',
      name: 'Martin',
      code: 'CODE01',
      createdAt: '2026-09-16T10:00:00.000Z',
    });
    assert.deepEqual(data.families, [family]);
  });

  test('a family name is required and at most 100 characters', () => {
    const { ledger, data } = setup();

    assertDomainError(() => ledger.createFamily(data, { name: '   ' }), 400, /nom/i);
    assertDomainError(() => ledger.createFamily(data, {}), 400, /nom/i);
    assertDomainError(() => ledger.createFamily(data, { name: 'x'.repeat(101) }), 400, /100/);
    assert.equal(ledger.createFamily(data, { name: 'x'.repeat(100) }).name.length, 100);
    assert.equal(data.families.length, 1);
  });
});

describe('family codes', () => {
  test('generated codes are 6 characters from the unambiguous alphabet', () => {
    const seen = new Set();
    for (let i = 0; i < 500; i++) {
      const code = generateCode();
      assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
      seen.add(code);
    }
    assert.ok(seen.size > 490, 'codes should be random');
  });

  test('codes are normalized: uppercase, spaces and dashes removed', () => {
    assert.equal(normalizeCode(' k7m-q4 x '), 'K7MQ4X');
    assert.equal(normalizeCode(undefined), '');
    assert.equal(normalizeCode(42), '');
  });

  test('a family is found by its code whatever the typing', () => {
    const { ledger, data } = setup({ codes: ['K7MQ4X', 'ABCDEF'] });
    const martin = ledger.createFamily(data, { name: 'Martin' });
    ledger.createFamily(data, { name: 'Durand' });

    assert.equal(ledger.findFamilyByCode(data, 'k7mq-4x'), martin);
    assert.equal(ledger.findFamilyByCode(data, 'K7MQ4Y'), null);
    assert.equal(ledger.findFamilyByCode(data, ''), null);
    assert.equal(ledger.findFamilyByCode(data, null), null);
  });

  test('a new code never collides with an existing one', () => {
    const { ledger, data } = setup({ codes: ['AAAAAA', 'AAAAAA', 'BBBBBB'] });
    ledger.createFamily(data, { name: 'Martin' });

    const durand = ledger.createFamily(data, { name: 'Durand' });

    assert.equal(durand.code, 'BBBBBB');
  });

  test('regenerating a code replaces it: the old code stops working', () => {
    const { ledger, data } = setup({ codes: ['AAAAAA', 'AAAAAA', 'BBBBBB'] });
    const martin = ledger.createFamily(data, { name: 'Martin' });

    const updated = ledger.regenerateCode(data, martin.id);

    assert.equal(updated.code, 'BBBBBB');
    assert.equal(ledger.findFamilyByCode(data, 'AAAAAA'), null);
    assert.equal(ledger.findFamilyByCode(data, 'BBBBBB').id, martin.id);
  });

  test('regenerating the code of an unknown family is a 404', () => {
    const { ledger, data } = setup();
    assertDomainError(() => ledger.regenerateCode(data, 'nope'), 404);
  });
});

describe('renaming and teens', () => {
  test('a family can be renamed', () => {
    const { ledger, data } = setup();
    const martin = ledger.createFamily(data, { name: 'Martin' });

    assert.equal(ledger.renameFamily(data, martin.id, { name: ' Martin-Dupont ' }).name, 'Martin-Dupont');
    assertDomainError(() => ledger.renameFamily(data, martin.id, { name: '' }), 400);
    assertDomainError(() => ledger.renameFamily(data, 'nope', { name: 'X' }), 404);
    assert.equal(data.families[0].name, 'Martin-Dupont');
  });

  test('a teen is added to a family with a trimmed first name', () => {
    const { ledger, data, tick } = setup();
    const martin = ledger.createFamily(data, { name: 'Martin' });
    tick();

    const lea = ledger.addTeen(data, martin.id, { firstName: ' Léa ' });

    assert.deepEqual(lea, {
      id: 'id2',
      familyId: martin.id,
      firstName: 'Léa',
      createdAt: '2026-09-16T10:00:01.000Z',
    });
    assert.deepEqual(data.teens, [lea]);
  });

  test('adding a teen requires an existing family and a valid first name', () => {
    const { ledger, data } = setup();
    const martin = ledger.createFamily(data, { name: 'Martin' });

    assertDomainError(() => ledger.addTeen(data, 'nope', { firstName: 'Léa' }), 404, /famille/i);
    assertDomainError(() => ledger.addTeen(data, martin.id, { firstName: ' ' }), 400, /prénom/i);
    assertDomainError(() => ledger.addTeen(data, martin.id, { firstName: 'é'.repeat(101) }), 400);
    assert.equal(data.teens.length, 0);
  });

  test('a teen can be renamed', () => {
    const { ledger, data } = setup();
    const martin = ledger.createFamily(data, { name: 'Martin' });
    const lea = ledger.addTeen(data, martin.id, { firstName: 'Léa' });

    assert.equal(ledger.renameTeen(data, lea.id, { firstName: 'Léane' }).firstName, 'Léane');
    assertDomainError(() => ledger.renameTeen(data, lea.id, { firstName: 3 }), 400);
    assertDomainError(() => ledger.renameTeen(data, 'nope', { firstName: 'X' }), 404, /ado/i);
  });
});

function seedFamilies(ctx) {
  const { ledger, data } = ctx;
  const martin = ledger.createFamily(data, { name: 'Martin' });
  const durand = ledger.createFamily(data, { name: 'Durand' });
  const lea = ledger.addTeen(data, martin.id, { firstName: 'Léa' });
  const tom = ledger.addTeen(data, martin.id, { firstName: 'Tom' });
  const zoe = ledger.addTeen(data, durand.id, { firstName: 'Zoé' });
  return { martin, durand, lea, tom, zoe };
}

describe('actions', () => {
  test('creating an action stores each participant share computed with the split rule', () => {
    const ctx = setup();
    const { lea, tom, zoe } = seedFamilies(ctx);
    ctx.tick();

    const action = ctx.ledger.createAction(ctx.data, {
      label: ' Vente de gâteaux ',
      date: '2026-12-14',
      totalCents: 10000,
      participants: [
        { teenId: zoe.id, parts: 1 },
        { teenId: lea.id, parts: 2 },
        { teenId: tom.id, parts: 1 },
      ],
    });

    assert.deepEqual(action, {
      id: action.id,
      label: 'Vente de gâteaux',
      date: '2026-12-14',
      totalCents: 10000,
      participants: [
        { teenId: zoe.id, parts: 1, amountCents: 2500 },
        { teenId: lea.id, parts: 2, amountCents: 5000 },
        { teenId: tom.id, parts: 1, amountCents: 2500 },
      ],
      createdAt: '2026-09-16T10:00:01.000Z',
      updatedAt: '2026-09-16T10:00:01.000Z',
    });
    assert.deepEqual(ctx.data.actions, [action]);
    assert.equal(ctx.ledger.teenBalance(ctx.data, lea.id), 5000);
    assert.equal(ctx.ledger.teenBalance(ctx.data, zoe.id), 2500);
  });

  test('an action is validated: label, date, total and participants', () => {
    const ctx = setup();
    const { lea, tom } = seedFamilies(ctx);
    const valid = {
      label: 'Tombola',
      date: '2026-12-14',
      totalCents: 3000,
      participants: [{ teenId: lea.id, parts: 1 }, { teenId: tom.id, parts: 1.5 }],
    };
    const invalid = (patch, pattern) =>
      assertDomainError(() => ctx.ledger.createAction(ctx.data, { ...valid, ...patch }), 400, pattern);

    invalid({ label: '  ' }, /libellé/i);
    invalid({ date: '2026-02-30' }, /date/i);
    invalid({ date: '14/12/2026' }, /date/i);
    invalid({ date: undefined }, /date/i);
    invalid({ totalCents: 0 }, /montant/i);
    invalid({ totalCents: -100 }, /montant/i);
    invalid({ totalCents: 10.5 }, /montant/i);
    invalid({ totalCents: '3000' }, /montant/i);
    invalid({ totalCents: 100_000_001 }, /montant/i); // > 1 000 000 € keeps integer math exact
    invalid({ participants: [] }, /participant/i);
    invalid({ participants: 'lea' }, /participant/i);
    invalid({ participants: [{ teenId: 'ghost', parts: 1 }] }, /ado/i);
    invalid({ participants: [{ teenId: lea.id, parts: 1 }, { teenId: lea.id, parts: 2 }] }, /Léa/);
    invalid({ participants: [{ teenId: lea.id, parts: 0 }] }, /parts/i);
    invalid({ participants: [{ teenId: lea.id, parts: -1 }] }, /parts/i);
    invalid({ participants: [{ teenId: lea.id, parts: 1.234 }] }, /parts/i);
    invalid({ participants: [{ teenId: lea.id, parts: '1' }] }, /parts/i);
    invalid({ participants: [{ teenId: lea.id }] }, /parts/i);
    invalid({ participants: [{ teenId: lea.id, parts: 1000.01 }] }, /parts/i);
    assert.equal(ctx.data.actions.length, 0);

    ctx.ledger.createAction(ctx.data, valid);
    ctx.ledger.createAction(ctx.data, { ...valid, date: '2028-02-29', participants: [{ teenId: lea.id, parts: 0.01 }] });
    assert.equal(ctx.data.actions.length, 2);
  });
});

function snapshot(data) {
  return structuredClone(data);
}

describe('movements', () => {
  test('credit and debit movements add to and subtract from the balance', () => {
    const ctx = setup();
    const { lea } = seedFamilies(ctx);

    const credit = ctx.ledger.createMovement(ctx.data, {
      teenId: lea.id,
      kind: 'credit',
      label: ' Report saison précédente ',
      date: '2026-09-01',
      amountCents: 3000,
    });
    ctx.ledger.createMovement(ctx.data, {
      teenId: lea.id,
      kind: 'debit',
      label: 'Déduit facture',
      date: '2026-11-02',
      amountCents: 2500,
    });

    assert.deepEqual(credit, {
      id: credit.id,
      teenId: lea.id,
      kind: 'credit',
      label: 'Report saison précédente',
      date: '2026-09-01',
      amountCents: 3000,
      createdAt: '2026-09-16T10:00:00.000Z',
    });
    assert.equal(ctx.data.movements.length, 2);
    assert.equal(ctx.ledger.teenBalance(ctx.data, lea.id), 500);
  });

  test('a movement is validated', () => {
    const ctx = setup();
    const { lea } = seedFamilies(ctx);
    const valid = { teenId: lea.id, kind: 'credit', label: 'Bonus', date: '2026-10-01', amountCents: 100 };
    const invalid = (patch, status, pattern) =>
      assertDomainError(() => ctx.ledger.createMovement(ctx.data, { ...valid, ...patch }), status, pattern);

    invalid({ teenId: 'ghost' }, 404, /ado/i);
    invalid({ kind: 'refund' }, 400, /type/i);
    invalid({ label: '' }, 400, /libellé/i);
    invalid({ date: '2026-13-01' }, 400, /date/i);
    invalid({ amountCents: 0 }, 400, /montant/i);
    invalid({ amountCents: 1.5 }, 400, /montant/i);
    assert.equal(ctx.data.movements.length, 0);
  });

  test('a debit that would make the balance negative is rejected with a 409 naming the teen', () => {
    const ctx = setup();
    const { lea } = seedFamilies(ctx);
    ctx.ledger.createMovement(ctx.data, { teenId: lea.id, kind: 'credit', label: 'Bonus', date: '2026-10-01', amountCents: 1000 });
    const before = snapshot(ctx.data);

    assertDomainError(
      () => ctx.ledger.createMovement(ctx.data, { teenId: lea.id, kind: 'debit', label: 'Facture', date: '2026-10-02', amountCents: 1001 }),
      409,
      /Léa \(Martin\).*-0,01 €/,
    );
    assert.deepEqual(ctx.data, before);

    ctx.ledger.createMovement(ctx.data, { teenId: lea.id, kind: 'debit', label: 'Facture', date: '2026-10-02', amountCents: 1000 });
    assert.equal(ctx.ledger.teenBalance(ctx.data, lea.id), 0);
  });
});

describe('editing and deleting credit history', () => {
  function withAction() {
    const ctx = setup();
    const teens = seedFamilies(ctx);
    const action = ctx.ledger.createAction(ctx.data, {
      label: 'Vente de gâteaux',
      date: '2026-12-14',
      totalCents: 3000,
      participants: [{ teenId: teens.lea.id, parts: 1 }, { teenId: teens.tom.id, parts: 2 }],
    });
    ctx.tick(60_000);
    return { ...ctx, ...teens, action };
  }

  const debit = (ctx, teen, amountCents) =>
    ctx.ledger.createMovement(ctx.data, { teenId: teen.id, kind: 'debit', label: 'Facture', date: '2026-12-20', amountCents });

  test('updating an action replaces its fields and recomputes shares', () => {
    const ctx = withAction();

    const updated = ctx.ledger.updateAction(ctx.data, ctx.action.id, {
      label: 'Vente de crêpes',
      date: '2026-12-15',
      totalCents: 1000,
      participants: [{ teenId: ctx.lea.id, parts: 1 }, { teenId: ctx.zoe.id, parts: 1 }, { teenId: ctx.tom.id, parts: 1 }],
    });

    assert.deepEqual(updated, {
      id: ctx.action.id,
      label: 'Vente de crêpes',
      date: '2026-12-15',
      totalCents: 1000,
      participants: [
        { teenId: ctx.lea.id, parts: 1, amountCents: 334 },
        { teenId: ctx.zoe.id, parts: 1, amountCents: 333 },
        { teenId: ctx.tom.id, parts: 1, amountCents: 333 },
      ],
      createdAt: '2026-09-16T10:00:00.000Z',
      updatedAt: '2026-09-16T10:01:00.000Z',
    });
    assert.deepEqual(ctx.data.actions, [updated]);
    assert.equal(ctx.ledger.teenBalance(ctx.data, ctx.tom.id), 333);
  });

  test('updating an unknown action is a 404, an invalid body a 400', () => {
    const ctx = withAction();
    assertDomainError(() => ctx.ledger.updateAction(ctx.data, 'nope', { label: 'x' }), 404, /action/i);
    assertDomainError(() => ctx.ledger.updateAction(ctx.data, ctx.action.id, { label: 'x' }), 400);
  });

  test('an action update that would leave a teen negative is rejected, naming every affected teen', () => {
    const ctx = withAction(); // Léa 1000, Tom 2000
    debit(ctx, ctx.lea, 800);
    debit(ctx, ctx.tom, 1500);
    const before = snapshot(ctx.data);

    assertDomainError(
      () =>
        ctx.ledger.updateAction(ctx.data, ctx.action.id, {
          label: 'Vente de gâteaux',
          date: '2026-12-14',
          totalCents: 1200,
          participants: [{ teenId: ctx.lea.id, parts: 1 }, { teenId: ctx.tom.id, parts: 2 }],
        }),
      409,
      /soldes de Léa \(Martin\) et Tom \(Martin\) deviendraient négatifs \(respectivement -4,00 € et -7,00 €\)/,
    );
    assertDomainError(
      () =>
        ctx.ledger.updateAction(ctx.data, ctx.action.id, {
          label: 'Vente de gâteaux',
          date: '2026-12-14',
          totalCents: 3000,
          participants: [{ teenId: ctx.tom.id, parts: 1 }],
        }),
      409,
      /le solde de Léa \(Martin\) deviendrait négatif \(-8,00 €\)/,
    );
    assert.deepEqual(ctx.data, before);
  });

  test('deleting an action removes the shares, unless a participant already spent them', () => {
    const ctx = withAction();
    const other = ctx.ledger.createAction(ctx.data, {
      label: 'Tombola', date: '2026-12-01', totalCents: 500, participants: [{ teenId: ctx.zoe.id, parts: 1 }],
    });
    debit(ctx, ctx.tom, 1);
    const before = snapshot(ctx.data);

    assertDomainError(() => ctx.ledger.deleteAction(ctx.data, ctx.action.id), 409, /Tom \(Martin\)/);
    assert.deepEqual(ctx.data, before);

    ctx.ledger.deleteAction(ctx.data, other.id);
    assert.deepEqual(ctx.data.actions.map((a) => a.id), [ctx.action.id]);
    assert.equal(ctx.ledger.teenBalance(ctx.data, ctx.zoe.id), 0);
    assertDomainError(() => ctx.ledger.deleteAction(ctx.data, other.id), 404);
  });

  test('deleting a movement: a debit always, a credit only if the balance stays non-negative', () => {
    const ctx = setup();
    const { lea } = seedFamilies(ctx);
    const credit = ctx.ledger.createMovement(ctx.data, { teenId: lea.id, kind: 'credit', label: 'Bonus', date: '2026-10-01', amountCents: 1000 });
    const spent = debit(ctx, lea, 400);
    const before = snapshot(ctx.data);

    assertDomainError(() => ctx.ledger.deleteMovement(ctx.data, credit.id), 409, /Léa \(Martin\).*-4,00 €/);
    assert.deepEqual(ctx.data, before);

    ctx.ledger.deleteMovement(ctx.data, spent.id);
    ctx.ledger.deleteMovement(ctx.data, credit.id);
    assert.deepEqual(ctx.data.movements, []);
    assertDomainError(() => ctx.ledger.deleteMovement(ctx.data, credit.id), 404, /mouvement/i);
  });
});

describe('deletion rules', () => {
  test('a teen without history can be deleted', () => {
    const ctx = setup();
    const { lea, tom } = seedFamilies(ctx);

    ctx.ledger.deleteTeen(ctx.data, lea.id);

    assert.deepEqual(ctx.data.teens.map((t) => t.firstName), ['Tom', 'Zoé']);
    assertDomainError(() => ctx.ledger.deleteTeen(ctx.data, lea.id), 404);
    assert.ok(tom);
  });

  test('a teen with a movement or in an action cannot be deleted', () => {
    const ctx = setup();
    const { lea, tom, zoe } = seedFamilies(ctx);
    ctx.ledger.createMovement(ctx.data, { teenId: lea.id, kind: 'credit', label: 'Bonus', date: '2026-10-01', amountCents: 100 });
    ctx.ledger.createAction(ctx.data, { label: 'Tombola', date: '2026-10-01', totalCents: 100, participants: [{ teenId: tom.id, parts: 1 }] });
    const before = snapshot(ctx.data);

    assertDomainError(() => ctx.ledger.deleteTeen(ctx.data, lea.id), 409, /Léa/);
    assertDomainError(() => ctx.ledger.deleteTeen(ctx.data, tom.id), 409, /Tom/);
    assert.deepEqual(ctx.data, before);
    ctx.ledger.deleteTeen(ctx.data, zoe.id);
  });

  test('a family is deleted with its teens when all of them are deletable', () => {
    const ctx = setup();
    const { martin, durand, zoe } = seedFamilies(ctx);
    ctx.ledger.createMovement(ctx.data, { teenId: zoe.id, kind: 'credit', label: 'Bonus', date: '2026-10-01', amountCents: 100 });

    ctx.ledger.deleteFamily(ctx.data, martin.id);

    assert.deepEqual(ctx.data.families.map((f) => f.name), ['Durand']);
    assert.deepEqual(ctx.data.teens.map((t) => t.firstName), ['Zoé']);
    assertDomainError(() => ctx.ledger.deleteFamily(ctx.data, martin.id), 404);

    const before = snapshot(ctx.data);
    assertDomainError(() => ctx.ledger.deleteFamily(ctx.data, durand.id), 409, /Zoé/);
    assert.deepEqual(ctx.data, before);
  });
});

describe('family view', () => {
  test('shows only this family: teens by first name, balances and history, never action totals or other participants', () => {
    const ctx = setup();
    const { martin, lea, tom, zoe } = seedFamilies(ctx);
    const hugo = ctx.ledger.addTeen(ctx.data, martin.id, { firstName: 'Hugo' });
    ctx.tick();
    ctx.ledger.createAction(ctx.data, {
      label: 'Vente de gâteaux',
      date: '2026-12-14',
      totalCents: 10000,
      participants: [
        { teenId: zoe.id, parts: 1 },
        { teenId: lea.id, parts: 2 },
        { teenId: tom.id, parts: 1.5 },
      ],
    });
    ctx.tick();
    ctx.ledger.createMovement(ctx.data, { teenId: lea.id, kind: 'debit', label: 'Déduit facture', date: '2026-12-14', amountCents: 2500 });
    ctx.tick();
    ctx.ledger.createMovement(ctx.data, { teenId: lea.id, kind: 'credit', label: 'Report', date: '2026-09-01', amountCents: 500 });
    ctx.tick();
    ctx.ledger.createAction(ctx.data, {
      label: 'Secret Durand', date: '2027-01-01', totalCents: 999, participants: [{ teenId: zoe.id, parts: 1 }],
    });

    const view = ctx.ledger.familyView(ctx.data, martin.id);

    assert.deepEqual(view, {
      family: { name: 'Martin' },
      teens: [
        { firstName: 'Hugo', balanceCents: 0, history: [] },
        {
          firstName: 'Léa',
          balanceCents: 2445,
          history: [
            { date: '2026-12-14', label: 'Déduit facture', amountCents: -2500, parts: null },
            { date: '2026-12-14', label: 'Vente de gâteaux', amountCents: 4445, parts: 2 },
            { date: '2026-09-01', label: 'Report', amountCents: 500, parts: null },
          ],
        },
        {
          firstName: 'Tom',
          balanceCents: 3333,
          history: [{ date: '2026-12-14', label: 'Vente de gâteaux', amountCents: 3333, parts: 1.5 }],
        },
      ],
      totalCents: 5778,
      updatedAt: '2026-09-16T10:00:03.000Z',
    });
    assert.ok(hugo);
    assert.doesNotMatch(JSON.stringify(view), /Zoé|Durand|Secret|10000|2222|participants|"code"|"id"/);
  });

  test('updatedAt is null until a credit change touches one of the family teens, deletions included', () => {
    const ctx = setup();
    const { martin, durand, lea, zoe } = seedFamilies(ctx);
    assert.equal(ctx.ledger.familyView(ctx.data, martin.id).updatedAt, null);

    ctx.tick();
    ctx.ledger.createMovement(ctx.data, { teenId: zoe.id, kind: 'credit', label: 'Bonus', date: '2026-10-01', amountCents: 100 });
    assert.equal(ctx.ledger.familyView(ctx.data, martin.id).updatedAt, null);
    assert.equal(ctx.ledger.familyView(ctx.data, durand.id).updatedAt, '2026-09-16T10:00:01.000Z');

    ctx.tick();
    const action = ctx.ledger.createAction(ctx.data, {
      label: 'Tombola', date: '2026-10-02', totalCents: 100, participants: [{ teenId: lea.id, parts: 1 }],
    });
    assert.equal(ctx.ledger.familyView(ctx.data, martin.id).updatedAt, '2026-09-16T10:00:02.000Z');

    ctx.tick();
    ctx.ledger.updateAction(ctx.data, action.id, {
      label: 'Tombola', date: '2026-10-02', totalCents: 100, participants: [{ teenId: zoe.id, parts: 1 }],
    });
    assert.equal(ctx.ledger.familyView(ctx.data, martin.id).updatedAt, '2026-09-16T10:00:03.000Z', 'teen removed from action');
    assert.equal(ctx.ledger.familyView(ctx.data, durand.id).updatedAt, '2026-09-16T10:00:03.000Z');

    ctx.tick();
    ctx.ledger.deleteAction(ctx.data, action.id);
    assert.equal(ctx.ledger.familyView(ctx.data, martin.id).updatedAt, '2026-09-16T10:00:03.000Z');
    assert.equal(ctx.ledger.familyView(ctx.data, durand.id).updatedAt, '2026-09-16T10:00:04.000Z');
  });
});

describe('admin state', () => {
  test('lists families by name with code, share message, teens, balances, history and deletability', () => {
    const ctx = setup({ codes: ['MARTIN', 'DURAND'] });
    const { lea, tom, zoe } = seedFamilies(ctx);
    ctx.tick();
    const action = ctx.ledger.createAction(ctx.data, {
      label: 'Tombola', date: '2026-10-02', totalCents: 1000, participants: [{ teenId: lea.id, parts: 1 }, { teenId: zoe.id, parts: 1.5 }],
    });
    ctx.tick();
    const debit = ctx.ledger.createMovement(ctx.data, { teenId: lea.id, kind: 'debit', label: 'Facture', date: '2026-10-03', amountCents: 100 });

    const state = ctx.ledger.adminState(ctx.data, { publicUrl: 'https://credit-ado.example' });

    assert.deepEqual(state.families.map((f) => [f.name, f.code, f.totalCents, f.deletable]), [
      ['Durand', 'DURAND', 600, false],
      ['Martin', 'MARTIN', 300, false],
    ]);
    const martin = state.families[1];
    assert.equal(
      martin.shareMessage,
      'Bonjour, retrouvez les crédits ados de la famille Martin sur https://credit-ado.example avec le code : MARTIN',
    );
    assert.equal(martin.updatedAt, '2026-09-16T10:00:02.000Z');
    assert.deepEqual(martin.teens, [
      {
        id: lea.id,
        familyId: lea.familyId,
        firstName: 'Léa',
        createdAt: lea.createdAt,
        balanceCents: 300,
        deletable: false,
        history: [
          { type: 'debit', id: debit.id, date: '2026-10-03', label: 'Facture', amountCents: -100, parts: null, createdAt: debit.createdAt },
          { type: 'action', id: action.id, date: '2026-10-02', label: 'Tombola', amountCents: 400, parts: 1, createdAt: action.createdAt },
        ],
      },
      { id: tom.id, familyId: tom.familyId, firstName: 'Tom', createdAt: tom.createdAt, balanceCents: 0, deletable: true, history: [] },
    ]);
    assert.deepEqual(state.actions, [action]);
    assert.deepEqual(state.movements, [debit]);
  });

  test('actions and movements are listed most recent first', () => {
    const ctx = setup();
    const { lea } = seedFamilies(ctx);
    const mk = (label, date) => {
      ctx.tick();
      ctx.ledger.createAction(ctx.data, { label, date, totalCents: 100, participants: [{ teenId: lea.id, parts: 1 }] });
      ctx.ledger.createMovement(ctx.data, { teenId: lea.id, kind: 'credit', label, date, amountCents: 100 });
    };
    mk('old', '2026-01-01');
    mk('newest', '2026-06-01');
    mk('same day, later', '2026-01-01');

    const state = ctx.ledger.adminState(ctx.data, { publicUrl: 'https://x' });

    assert.deepEqual(state.actions.map((a) => a.label), ['newest', 'same day, later', 'old']);
    assert.deepEqual(state.movements.map((m) => m.label), ['newest', 'same day, later', 'old']);
  });
});

describe('CSV export', () => {
  test('one row per history line: BOM, semicolons, French dates and decimals, signed amounts', () => {
    const ctx = setup();
    const { lea, tom, zoe } = seedFamilies(ctx);
    ctx.ledger.createMovement(ctx.data, { teenId: lea.id, kind: 'credit', label: 'Report; "saison" passée', date: '2026-09-01', amountCents: 500 });
    ctx.tick();
    ctx.ledger.createAction(ctx.data, {
      label: 'Vente de gâteaux',
      date: '2026-12-14',
      totalCents: 10000,
      participants: [{ teenId: zoe.id, parts: 1 }, { teenId: lea.id, parts: 2 }, { teenId: tom.id, parts: 1.5 }],
    });
    ctx.tick();
    ctx.ledger.createMovement(ctx.data, { teenId: lea.id, kind: 'debit', label: 'Déduit facture', date: '2026-12-20', amountCents: 123456 - 121011 });

    const csv = ctx.ledger.exportCsv(ctx.data);

    assert.equal(
      csv,
      '﻿' +
        [
          'Date;Famille;Ado;Type;Libellé;Parts;Montant',
          '01/09/2026;Martin;Léa;Ajout;"Report; ""saison"" passée";;5,00',
          '14/12/2026;Durand;Zoé;Action;Vente de gâteaux;1;22,22',
          '14/12/2026;Martin;Léa;Action;Vente de gâteaux;2;44,45',
          '14/12/2026;Martin;Tom;Action;Vente de gâteaux;1,5;33,33',
          '20/12/2026;Martin;Léa;Déduction;Déduit facture;;-24,45',
        ].join('\r\n') +
        '\r\n',
    );
  });

  test('an empty ledger exports only the header', () => {
    const { ledger, data } = setup();
    assert.equal(ledger.exportCsv(data), '﻿Date;Famille;Ado;Type;Libellé;Parts;Montant\r\n');
  });
});

test('formatCents writes French decimals with a sign', () => {
  assert.equal(formatCents(1333), '13,33');
  assert.equal(formatCents(-2500), '-25,00');
  assert.equal(formatCents(5), '0,05');
  assert.equal(formatCents(0), '0,00');
  assert.equal(formatCents(123456789), '1234567,89');
});
