import { useState } from "react";
import {
  buildSettlementText,
  formatMoney,
  derivePlayer,
  gameBuyIn,
} from "../calculations.js";

export function Amount({ cents, signed = true }) {
  return (
    <span
      className={`money ${cents > 0 ? "positive" : cents < 0 ? "negative" : ""}`}
    >
      {formatMoney(cents, { signed })}
    </span>
  );
}
export function Totals({ inputs, game }) {
  let amount = 0,
    chips = 0,
    entered = 0;
  for (const p of inputs) {
    try {
      const d = derivePlayer(p, game);
      amount += d.amountPaidCents;
      if (d.finalChipsCents !== null) {
        chips += d.finalChipsCents;
        entered++;
      }
    } catch {
      /* Drafts can temporarily contain incomplete money. */
    }
  }
  const ready = entered === inputs.length;
  return (
    <div className="totals">
      <div>
        <span>{gameBuyIn(game).mode === "fixed" ? "Buy-ins" : "Players"}</span>
        <strong>
          {gameBuyIn(game).mode === "fixed"
            ? inputs.reduce((s, p) => s + p.buyIns, 0)
            : inputs.length}
        </strong>
      </div>
      <div>
        <span>Collected</span>
        <strong>{formatMoney(amount)}</strong>
      </div>
      <div>
        <span>Final chips</span>
        <strong>
          {ready ? formatMoney(chips) : `${entered}/${inputs.length} entered`}
        </strong>
      </div>
      <div>
        <span>Variance</span>
        {ready ? <Amount cents={chips - amount} /> : <strong>—</strong>}
      </div>
    </div>
  );
}
export default function Results({ settlement, name }) {
  const [copy, setCopy] = useState("");
  async function copyText() {
    try {
      await navigator.clipboard.writeText(
        buildSettlementText(settlement, name),
      );
      setCopy("Copied!");
    } catch {
      setCopy("Copy failed. Select the text below to copy manually.");
    }
  }
  return (
    <section className="results">
      <div className="section-head">
        <h2>Results</h2>
        <button onClick={copyText}>Copy settlement</button>
      </div>
      {copy && <p role="status">{copy}</p>}
      {copy.startsWith("Copy failed") && (
        <textarea
          readOnly
          aria-label="Settlement text"
          value={buildSettlementText(settlement, name)}
        />
      )}
      <p className="muted">
        Table variance <Amount cents={settlement.totals.discrepancyCents} />.
        Adjustments apply only to raw winners, proportional to their winnings.
      </p>
      <div className="cards">
        {settlement.results.map((p) => (
          <article className="card" key={p.id}>
            <h3>{p.name}</h3>
            <dl>
              {p.buyIns !== null && (
                <div>
                  <dt>Buy-ins</dt>
                  <dd>{p.buyIns}</dd>
                </div>
              )}
              <div>
                <dt>Paid in</dt>
                <dd>{formatMoney(p.amountPaidCents)}</dd>
              </div>
              <div>
                <dt>Final chips</dt>
                <dd>{formatMoney(p.finalChipsCents)}</dd>
              </div>
              <div>
                <dt>Raw result</dt>
                <dd>
                  <Amount cents={p.rawResultCents} />
                </dd>
              </div>
              <div className="adjustment">
                <dt>Variance adjustment</dt>
                <dd>
                  <Amount cents={p.adjustmentCents} />
                </dd>
              </div>
              <div className="final-result">
                <dt>Final result</dt>
                <dd>
                  <Amount cents={p.adjustedResultCents} />
                </dd>
              </div>
            </dl>
          </article>
        ))}
      </div>
      <h2>
        Payments{" "}
        <span className="muted count">
          {settlement.payments.length} transfers
        </span>
      </h2>
      <div className="list">
        {settlement.payments.map((p, i) => (
          <div className="list-row" key={i}>
            <span>
              {p.fromName} <span className="muted">→</span> {p.toName}
            </span>
            <strong>{formatMoney(p.amountCents)}</strong>
          </div>
        ))}
        {!settlement.payments.length && (
          <p className="empty">No payments needed.</p>
        )}
      </div>
    </section>
  );
}
