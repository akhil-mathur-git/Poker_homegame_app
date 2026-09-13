import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateSettlement,
  findMinimumPayments,
  parseMoneyToCents,
  buildSettlementText,
} from "../src/calculations.js";
const players = (chips) =>
  chips.map((value, i) => ({
    id: String(i),
    name: ["Akhil", "Ben", "Josh", "Ryan"][i] ?? `P${i}`,
    buyIns: 2,
    finalChips: value,
  }));
function check(settlement) {
  const balances = new Map(
    settlement.results.map((p) => [p.id, p.adjustedResultCents]),
  );
  const original = new Map(balances);
  for (const p of settlement.payments) {
    assert.ok(Number.isSafeInteger(p.amountCents) && p.amountCents > 0);
    assert.ok(original.get(p.fromId) < 0);
    assert.ok(original.get(p.toId) > 0);
    balances.set(p.fromId, balances.get(p.fromId) + p.amountCents);
    balances.set(p.toId, balances.get(p.toId) - p.amountCents);
  }
  assert.ok([...balances.values()].every((v) => v === 0));
  assert.equal(
    settlement.results.reduce((s, p) => s + p.adjustedResultCents, 0),
    0,
  );
}
test("zero variance preserves original results", () => {
  const s = calculateSettlement(players(["50", "40", "20", "10"]));
  check(s);
  assert.deepEqual(
    s.results.map((p) => p.adjustedResultCents),
    [2000, 1000, -1000, -2000],
  );
  assert.equal(s.payments.length, 2);
});
test("positive variance deductions are proportional and rounded", () => {
  const s = calculateSettlement(players(["50", "40", "20", "15"]));
  check(s);
  assert.equal(s.totals.discrepancyCents, 500);
  assert.deepEqual(
    s.results.map((p) => p.adjustmentCents),
    [-333, -167, 0, 0],
  );
});
test("negative variance increases raw winners only", () => {
  const s = calculateSettlement(players(["50", "40", "20", "5"]));
  check(s);
  assert.deepEqual(
    s.results.map((p) => p.adjustmentCents),
    [333, 167, 0, 0],
  );
});
test("one-cent tie allocation is deterministic by player ID", () => {
  const p = players(["30.01", "30.01", "29.99", "30"]);
  const s = calculateSettlement(p);
  check(s);
  assert.deepEqual(
    s.results.map((p) => p.adjustmentCents),
    [-1, 0, 0, 0],
  );
  assert.deepEqual(s, calculateSettlement([...p].reverse()));
});
test("invalid inputs and unabsorbable no-winner variance fail", () => {
  assert.throws(() => calculateSettlement(players(["20", "20"])), /no winners/);
  assert.throws(() =>
    calculateSettlement([
      { id: "a", name: "A", buyIns: -1, finalChips: "0" },
      { id: "b", name: "B", buyIns: 1, finalChips: "30" },
    ]),
  );
  assert.throws(() => calculateSettlement(players(["-1", "40"])));
  assert.throws(() => calculateSettlement(players(["1.234", "40"])));
  assert.throws(() => calculateSettlement(players(["1000001", "40"])));
  assert.throws(() =>
    calculateSettlement([
      { id: "a", name: "A", buyIns: 1.5, finalChips: "0" },
      { id: "b", name: "B", buyIns: 1, finalChips: "30" },
    ]),
  );
  assert.equal(parseMoneyToCents("42.50"), 4250);
  assert.equal(parseMoneyToCents(""), 0);
  assert.equal(parseMoneyToCents("1e3"), null);
});
test("all equal inputs need no transfers", () => {
  const s = calculateSettlement(players(["30", "30"]));
  check(s);
  assert.deepEqual(s.payments, []);
});
// Independent exhaustive debtor-creditor DFS oracle for small balances.
function oracle(balances) {
  if (balances.every((x) => x === 0)) return 0;
  let best = Infinity;
  for (let i = 0; i < balances.length; i++)
    if (balances[i] < 0)
      for (let j = 0; j < balances.length; j++)
        if (balances[j] > 0) {
          const amount = Math.min(-balances[i], balances[j]),
            next = [...balances];
          next[i] += amount;
          next[j] -= amount;
          best = Math.min(best, 1 + oracle(next));
        }
  return best;
}
test("exact optimizer beats a simple greedy pairing counterexample", () => {
  const balances = [-600, -400, -400, 800, 600];
  const results = balances.map((b, i) => ({
    id: String(i),
    name: `P${i}`,
    adjustedResultCents: b,
  }));
  const payments = findMinimumPayments(results);
  assert.equal(payments.length, 3);
  check({ results, payments });
});
test("exact transfer counts agree with exhaustive oracle across many balances", () => {
  for (let a = 1; a <= 4; a++)
    for (let b = 1; b <= 4; b++)
      for (let c = 1; c < a + b; c++) {
        const balances = [-a, -b, c, a + b - c],
          results = balances.map((v, i) => ({
            id: String(i),
            name: `P${i}`,
            adjustedResultCents: v,
          }));
        const payments = findMinimumPayments(results);
        assert.equal(payments.length, oracle(balances));
        check({ results, payments });
      }
});
test("copy text makes nonzero variance transparent and includes game name", () => {
  const text = buildSettlementText(
    calculateSettlement(players(["50", "40", "20", "15"])),
    "Sunday Poker",
  );
  assert.match(text, /Poker Settlement - Sunday Poker/);
  assert.match(
    text,
    /Akhil: \+\$20.00 raw \| -\$3.33 variance \| \+\$16.67 final/,
  );
  assert.match(text, /Josh: -\$10.00\n/);
});
