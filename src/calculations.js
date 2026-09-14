export const BUY_IN_CENTS = 1500;

export function parseMoneyToCents(value) {
  const text = String(value ?? "").trim();
  if (text === "") return 0;
  if (!/^\d+(?:\.\d{0,2})?$/.test(text)) return null;

  const [dollars, decimal = ""] = text.split(".");
  const cents = Number(dollars) * 100 + Number(decimal.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

export function formatMoney(cents, { signed = false } = {}) {
  const sign = cents < 0 ? "-" : signed && cents > 0 ? "+" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

export const MAX_MONEY_CENTS = 100000000;
export function parseSignedMoneyToCents(value) {
  const text = String(value ?? "").trim();
  if (!/^[+-]?\d+(?:\.\d{0,2})?$/.test(text)) return null;
  const cents = parseMoneyToCents(text.replace(/^[+-]/, ""));
  return cents === null ? null : text.startsWith("-") ? -cents : cents;
}
export function gameBuyIn(game = {}) {
  const mode = game.buy_in_mode ?? "fixed";
  const value =
    mode === "fixed" ? (game.buy_in_value_cents ?? BUY_IN_CENTS) : null;
  if (
    !["fixed", "flexible"].includes(mode) ||
    (mode === "fixed" &&
      (!Number.isSafeInteger(value) || value <= 0 || value > MAX_MONEY_CENTS))
  )
    throw new Error("Enter a valid positive fixed buy-in value.");
  return { mode, value };
}
// One entered result, plus amount in, determines both outputs. Null means unentered.
export function derivePlayer(player, game = {}) {
  const { mode, value } = gameBuyIn(game);
  const amount =
    mode === "fixed"
      ? player.buyIns * value
      : parseMoneyToCents(player.amountIn);
  if (
    mode === "fixed" &&
    (!Number.isInteger(player.buyIns) ||
      player.buyIns < 0 ||
      player.buyIns > 10000)
  )
    throw new Error("Buy-ins must be a non-negative whole number.");
  if (
    amount === null ||
    !Number.isSafeInteger(amount) ||
    amount < 0 ||
    amount > MAX_MONEY_CENTS ||
    (mode === "flexible" && String(player.amountIn ?? "").trim() === "")
  )
    throw new Error("Enter a valid non-negative amount in (up to $1,000,000).");
  const source = player.resultEntryMode ?? "final_chips";
  const text = String(player.resultEntry ?? player.finalChips ?? "").trim();
  if (!["final_chips", "net_pl"].includes(source))
    throw new Error("Invalid result source.");
  const entered = text === "" ? null : parseSignedMoneyToCents(text);
  if (text !== "" && (entered === null || Math.abs(entered) > MAX_MONEY_CENTS))
    throw new Error("Enter a valid result with at most two decimal places.");
  const final =
    entered === null ? null : source === "net_pl" ? amount + entered : entered;
  if (final !== null && (final < 0 || final > MAX_MONEY_CENTS))
    throw new Error(
      "The result must produce final chips between $0 and $1,000,000.",
    );
  return {
    amountPaidCents: amount,
    amountInCents: amount,
    finalChipsCents: final,
    rawResultCents: final === null ? null : final - amount,
    resultEntryMode: source,
    resultEntryCents: entered,
    buyIns: mode === "fixed" ? player.buyIns : null,
  };
}
export function validatePlayers(players, game = {}) {
  if (players.length < 2 || players.length > 22)
    return "Choose between 2 and 22 players before calculating a settlement.";
  if (
    new Set(players.map((p) => p.id)).size !== players.length ||
    players.some((p) => !p.id)
  )
    return "Every player needs a unique ID.";
  const names = new Set();
  for (const player of players) {
    const name = player.name.trim();
    if (!name) return "Every player needs a name.";
    if (names.has(name.toLocaleLowerCase()))
      return "Player names must be unique so the settlement is unambiguous.";
    names.add(name.toLocaleLowerCase());
    try {
      if (derivePlayer(player, game).resultEntryCents === null)
        return "Enter a result for every player before calculating settlement.";
    } catch (error) {
      return `${name}: ${error.message}`;
    }
  }
  return null;
}

function distributeDiscrepancy(results, discrepancyCents) {
  const adjustments = new Map(results.map((result) => [result.id, 0]));
  if (discrepancyCents === 0) return adjustments;

  const winners = results.filter((result) => result.rawResultCents > 0);
  if (winners.length === 0) {
    throw new Error(
      `The game is off by ${formatMoney(discrepancyCents, { signed: true })}, but there are no winners to adjust. Check the chip counts and buy-ins.`,
    );
  }

  const totalWinnerProfit = winners.reduce(
    (total, winner) => total + winner.rawResultCents,
    0,
  );
  const discrepancyMagnitude = Math.abs(discrepancyCents);
  const direction = Math.sign(discrepancyCents);
  let allocatedCents = 0;

  const shares = winners.map((winner, index) => {
    const numerator =
      BigInt(discrepancyMagnitude) * BigInt(winner.rawResultCents);
    const denominator = BigInt(totalWinnerProfit);
    const baseCents = Number(numerator / denominator);
    allocatedCents += baseCents;
    return {
      id: winner.id,
      index,
      baseCents,
      remainder: numerator % denominator,
    };
  });

  shares.sort((a, b) => {
    if (a.remainder === b.remainder) return a.index - b.index;
    return a.remainder > b.remainder ? -1 : 1;
  });

  const leftoverCents = discrepancyMagnitude - allocatedCents;
  shares.forEach((share, rank) => {
    const discrepancyShare =
      direction * (share.baseCents + (rank < leftoverCents ? 1 : 0));
    adjustments.set(share.id, discrepancyShare === 0 ? 0 : -discrepancyShare);
  });

  return adjustments;
}

/**
 * An exact minimum-transfer settlement. Every valid settlement consists of
 * zero-sum connected groups. A group of n people needs at least n - 1
 * transfers, so maximizing the number of disjoint zero-sum groups minimizes
 * transfers. This subset DP does that exactly and uses player order to break
 * ties deterministically.
 */
export function findMinimumPayments(results) {
  const active = results
    .map((result, index) => ({ ...result, originalIndex: index }))
    .filter((result) => result.adjustedResultCents !== 0);

  if (active.length === 0) return [];
  if (active.length > 22) {
    throw new Error(
      "Exact settlement is limited to 22 players with non-zero balances. Remove settled players or split this unusually large game.",
    );
  }

  const balanceTotal = active.reduce(
    (total, result) => total + result.adjustedResultCents,
    0,
  );
  if (balanceTotal !== 0) {
    throw new Error("The adjusted balances do not add up to zero cents.");
  }

  const stateCount = 2 ** active.length;
  const subsetSums = new Float64Array(stateCount);
  const bestGroups = new Int8Array(stateCount);
  const parent = new Int8Array(stateCount);
  bestGroups.fill(-1);
  parent.fill(-1);
  bestGroups[0] = 0;

  for (let mask = 1; mask < stateCount; mask += 1) {
    const lowestBit = mask & -mask;
    const lowestIndex = 31 - Math.clz32(lowestBit);
    subsetSums[mask] =
      subsetSums[mask ^ lowestBit] + active[lowestIndex].adjustedResultCents;
    const groupBonus = subsetSums[mask] === 0 ? 1 : 0;

    for (let index = 0; index < active.length; index += 1) {
      const bit = 2 ** index;
      if ((mask & bit) === 0) continue;

      const previousMask = mask ^ bit;
      const candidate = bestGroups[previousMask] + groupBonus;
      if (candidate > bestGroups[mask]) {
        bestGroups[mask] = candidate;
        parent[mask] = index;
      }
    }
  }

  const orderedIndexes = [];
  let mask = stateCount - 1;
  while (mask) {
    const index = parent[mask];
    orderedIndexes.push(index);
    mask ^= 2 ** index;
  }
  orderedIndexes.reverse();

  const groups = [];
  let group = [];
  let runningTotal = 0;
  for (const index of orderedIndexes) {
    group.push(active[index]);
    runningTotal += active[index].adjustedResultCents;
    if (runningTotal === 0) {
      groups.push(group);
      group = [];
    }
  }

  const payments = [];
  for (const zeroSumGroup of groups) {
    const debtors = zeroSumGroup
      .filter((result) => result.adjustedResultCents < 0)
      .sort((a, b) => a.originalIndex - b.originalIndex)
      .map((result) => ({ ...result, remaining: -result.adjustedResultCents }));
    const creditors = zeroSumGroup
      .filter((result) => result.adjustedResultCents > 0)
      .sort((a, b) => a.originalIndex - b.originalIndex)
      .map((result) => ({ ...result, remaining: result.adjustedResultCents }));

    let debtorIndex = 0;
    let creditorIndex = 0;
    while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
      const debtor = debtors[debtorIndex];
      const creditor = creditors[creditorIndex];
      const amountCents = Math.min(debtor.remaining, creditor.remaining);

      if (amountCents > 0) {
        payments.push({
          fromId: debtor.id,
          fromName: debtor.name,
          toId: creditor.id,
          toName: creditor.name,
          amountCents,
        });
      }

      debtor.remaining -= amountCents;
      creditor.remaining -= amountCents;
      if (debtor.remaining === 0) debtorIndex += 1;
      if (creditor.remaining === 0) creditorIndex += 1;
    }
  }

  return payments;
}

export function calculateSettlement(players, game = {}) {
  const validationError = validatePlayers(players, game);
  if (validationError) throw new Error(validationError);

  const results = [...players]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((player) => ({
      id: player.id,
      name: player.name.trim(),
      ...derivePlayer(player, game),
    }));

  const totalBuyIns =
    gameBuyIn(game).mode === "flexible"
      ? null
      : results.reduce((total, result) => total + result.buyIns, 0);
  const totalMoneyCollectedCents = results.reduce(
    (total, result) => total + result.amountPaidCents,
    0,
  );
  const totalFinalChipsCents = results.reduce(
    (total, result) => total + result.finalChipsCents,
    0,
  );
  const discrepancyCents = totalFinalChipsCents - totalMoneyCollectedCents;
  const adjustments = distributeDiscrepancy(results, discrepancyCents);

  const adjustedResults = results.map((result) => {
    const adjustmentCents = adjustments.get(result.id);
    const adjustedResultCents = result.rawResultCents + adjustmentCents;
    if (result.rawResultCents > 0 && adjustedResultCents < 0) {
      throw new Error(
        `The variance is too large: it would make ${result.name} owe money even though they were a winner. Check the game totals.`,
      );
    }
    return { ...result, adjustmentCents, adjustedResultCents };
  });

  const adjustedTotal = adjustedResults.reduce(
    (total, result) => total + result.adjustedResultCents,
    0,
  );
  if (adjustedTotal !== 0) {
    throw new Error("The adjusted balances do not add up to zero cents.");
  }

  return {
    results: adjustedResults,
    payments: findMinimumPayments(adjustedResults),
    totals: {
      totalBuyIns,
      totalMoneyCollectedCents,
      totalFinalChipsCents,
      discrepancyCents,
    },
  };
}

export function buildSettlementText(settlement, name = "") {
  const resultLines = settlement.results.map((result) =>
    result.adjustmentCents !== 0
      ? `${result.name}: ${formatMoney(result.rawResultCents, { signed: true })} raw | ${formatMoney(result.adjustmentCents, { signed: true })} variance | ${formatMoney(result.adjustedResultCents, { signed: true })} final`
      : `${result.name}: ${formatMoney(result.adjustedResultCents, { signed: true })}`,
  );
  const paymentLines = settlement.payments.length
    ? settlement.payments.map(
        (payment) =>
          `${payment.fromName} -> ${payment.toName}: ${formatMoney(payment.amountCents)}`,
      )
    : ["No payments needed."];

  return [
    `Poker Settlement${name ? ` - ${name}` : ""}`,
    "",
    "Results:",
    ...resultLines,
    "",
    "Payments:",
    ...paymentLines,
    "",
    `Table variance: ${formatMoney(settlement.totals.discrepancyCents, { signed: true })}`,
  ].join("\n");
}
