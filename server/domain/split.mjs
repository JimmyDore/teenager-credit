// Tricount-style split: share_i = total × parts_i / Σparts, rounded with the
// largest-remainder method in integer arithmetic so that Σshares === total.
//
// Pure and dependency-free on purpose: the admin page can import the very
// same file for its live preview.

const PARTS_SCALE = 100; // parts have at most 2 decimals

export function scaleParts(parts) {
  return Math.round(parts * PARTS_SCALE);
}

/**
 * @param {number} totalCents positive integer
 * @param {{teenId: string, firstName: string, parts: number}[]} participants
 * @returns {{teenId: string, parts: number, amountCents: number}[]} same order as input
 */
export function splitAmount(totalCents, participants) {
  const scaled = participants.map((p) => scaleParts(p.parts));
  const totalParts = scaled.reduce((sum, p) => sum + p, 0);

  const rows = participants.map((p, index) => {
    const numerator = totalCents * scaled[index];
    return {
      index,
      base: Math.floor(numerator / totalParts),
      remainder: numerator % totalParts,
    };
  });

  let leftover = totalCents - rows.reduce((sum, r) => sum + r.base, 0);
  const byLargestRemainder = [...rows].sort(
    (x, y) =>
      y.remainder - x.remainder ||
      participants[x.index].firstName.localeCompare(participants[y.index].firstName, 'fr') ||
      compareIds(participants[x.index].teenId, participants[y.index].teenId),
  );
  for (const row of byLargestRemainder) {
    if (leftover === 0) break;
    row.base += 1;
    leftover -= 1;
  }

  return participants.map((p, index) => ({
    teenId: p.teenId,
    parts: p.parts,
    amountCents: rows[index].base,
  }));
}

function compareIds(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
