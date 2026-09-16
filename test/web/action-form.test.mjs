import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { previewAction } from '../../public/js/action-form.mjs';
// The browser loads the very same file from /shared/split.mjs.
import { splitAmount } from '../../server/domain/split.mjs';

const row = (teenId, firstName, partsInput = '1', checked = true) => ({ teenId, firstName, partsInput, checked });

describe('previewAction', () => {
  test('splits the total between checked teens according to their parts', () => {
    const preview = previewAction(
      { totalInput: '100', rows: [row('lea', 'Léa', '2'), row('hugo', 'Hugo'), row('ines', 'Inès')] },
      splitAmount,
    );
    assert.deepEqual(preview.shares, { lea: 5000, hugo: 2500, ines: 2500 });
    assert.equal(preview.sumCents, 10000);
    assert.equal(preview.partsTotal, 4);
    assert.equal(preview.totalCents, 10000);
    assert.deepEqual(preview.participants, [
      { teenId: 'lea', parts: 2 },
      { teenId: 'hugo', parts: 1 },
      { teenId: 'ines', parts: 1 },
    ]);
    assert.equal(preview.error, null);
  });

  test('ignores unchecked teens and accepts decimal parts with a comma', () => {
    const preview = previewAction(
      { totalInput: '12,50', rows: [row('lea', 'Léa', '1,5'), row('hugo', 'Hugo', '3', false), row('ines', 'Inès', '1')] },
      splitAmount,
    );
    assert.deepEqual(preview.shares, { lea: 750, ines: 500 });
    assert.deepEqual(preview.participants, [
      { teenId: 'lea', parts: 1.5 },
      { teenId: 'ines', parts: 1 },
    ]);
    assert.equal(preview.partsTotal, 2.5);
    assert.equal(preview.error, null);
  });

  test('without a valid total there is no share, and the error says why', () => {
    const preview = previewAction({ totalInput: '12,505', rows: [row('lea', 'Léa')] }, splitAmount);
    assert.equal(preview.totalCents, null);
    assert.deepEqual(preview.shares, {});
    assert.equal(preview.sumCents, 0);
    assert.equal(preview.error, 'Saisissez un montant total valide (ex. 120 ou 45,50).');
  });

  test('an invalid parts value names the teen and blocks the whole preview', () => {
    const preview = previewAction(
      { totalInput: '100', rows: [row('lea', 'Léa', '0'), row('hugo', 'Hugo', '1')] },
      splitAmount,
    );
    assert.deepEqual(preview.invalidTeenIds, ['lea']);
    assert.deepEqual(preview.shares, {});
    assert.equal(preview.error, 'Nombre de parts invalide pour Léa (positif, 2 décimales au plus).');
  });

  test('at least one participant is required', () => {
    const preview = previewAction({ totalInput: '100', rows: [row('lea', 'Léa', '1', false)] }, splitAmount);
    assert.deepEqual(preview.participants, []);
    assert.deepEqual(preview.shares, {});
    assert.equal(preview.error, 'Choisissez au moins un participant.');
  });
});
