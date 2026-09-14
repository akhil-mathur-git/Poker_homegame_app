import test from "node:test";
import assert from "node:assert/strict";
import {
  derivePlayer,
  calculateSettlement,
  parseSignedMoneyToCents,
} from "../src/calculations.js";
const fixed = (value) => ({ buy_in_mode: "fixed", buy_in_value_cents: value });
const flexible = { buy_in_mode: "flexible", buy_in_value_cents: null };
const player = {
  id: "a",
  name: "A",
  buyIns: 3,
  resultEntryMode: "final_chips",
  resultEntry: "68.00",
};
test("fixed values and flexible amounts use integer cents", () => {
  assert.equal(derivePlayer(player, fixed(1500)).amountInCents, 4500);
  assert.equal(derivePlayer(player, fixed(2000)).amountInCents, 6000);
  assert.equal(
    derivePlayer({ ...player, amountIn: "47.50" }, flexible).amountInCents,
    4750,
  );
  assert.equal(derivePlayer(player, fixed(2550)).amountInCents, 7650);
});
test("both result sources derive equivalent outputs", () => {
  const chips = derivePlayer(player, fixed(1500));
  assert.equal(chips.rawResultCents, 2300);
  const net = derivePlayer(
    { ...player, resultEntryMode: "net_pl", resultEntry: "+23" },
    fixed(1500),
  );
  assert.equal(net.finalChipsCents, 6800);
  assert.equal(
    derivePlayer(
      { ...player, resultEntryMode: "net_pl", resultEntry: "-15" },
      fixed(1500),
    ).finalChipsCents,
    3000,
  );
});
test("amount changes preserve the entered source", () => {
  const net = { ...player, resultEntryMode: "net_pl", resultEntry: "23" };
  assert.equal(
    derivePlayer({ ...net, buyIns: 4 }, fixed(1500)).finalChipsCents,
    8300,
  );
  assert.equal(
    derivePlayer({ ...net, buyIns: 4 }, fixed(1500)).rawResultCents,
    2300,
  );
  assert.equal(
    derivePlayer({ ...player, buyIns: 4 }, fixed(1500)).finalChipsCents,
    6800,
  );
  assert.equal(
    derivePlayer({ ...player, buyIns: 4 }, fixed(1500)).rawResultCents,
    800,
  );
});
test("blank results remain distinct from zero and block settlement", () => {
  assert.equal(
    derivePlayer({ ...player, resultEntry: "" }, fixed(1500)).finalChipsCents,
    null,
  );
  assert.equal(
    derivePlayer({ ...player, resultEntry: "0" }, fixed(1500)).rawResultCents,
    -4500,
  );
  assert.throws(
    () =>
      calculateSettlement(
        [player, { ...player, id: "b", name: "B", resultEntry: "" }],
        fixed(1500),
      ),
    /Enter a result for every player/,
  );
});
test("invalid amounts, negative derived chips, fractions and malformed results fail", () => {
  assert.throws(
    () =>
      derivePlayer(
        { ...player, buyIns: 1, resultEntryMode: "net_pl", resultEntry: "-20" },
        fixed(1500),
      ),
    /final chips/,
  );
  for (const resultEntry of ["abc", "1.234", "1e3", "--3"])
    assert.throws(() => derivePlayer({ ...player, resultEntry }, fixed(1500)));
  for (const value of [0, -1, 1.5])
    assert.throws(() => derivePlayer(player, fixed(value)));
  assert.throws(() => derivePlayer({ ...player, buyIns: 1.5 }, fixed(1500)));
  for (const amountIn of ["", "-1", "12.123"])
    assert.throws(() => derivePlayer({ ...player, amountIn }, flexible));
  assert.equal(parseSignedMoneyToCents("+23.01"), 2301);
  assert.equal(parseSignedMoneyToCents("-0.01"), -1);
});
test("mixed sources and flexible amounts preserve variance and exact settlements", () => {
  for (const last of ["15", "5"]) {
    const entries = ["50", "40", "20", last].map((chips, i) => ({
      id: String(i),
      name: `P${i}`,
      buyIns: 2,
      resultEntryMode: i % 2 ? "net_pl" : "final_chips",
      resultEntry: i % 2 ? String(Number(chips) - 30) : chips,
    }));
    const a = calculateSettlement(entries, fixed(1500));
    const b = calculateSettlement(
      entries.map((p) => ({ ...p, amountIn: "30" })),
      flexible,
    );
    assert.deepEqual(a.payments, b.payments);
    assert.equal(
      a.results.reduce((s, p) => s + p.adjustedResultCents, 0),
      0,
    );
    assert.equal(b.totals.totalBuyIns, null);
    const balances = new Map(
      b.results.map((p) => [p.id, p.adjustedResultCents]),
    );
    for (const pay of b.payments) {
      assert.ok(balances.get(pay.fromId) < 0);
      assert.ok(balances.get(pay.toId) > 0);
    }
  }
});
