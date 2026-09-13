import { useState } from "react";
import {
  buildSettlementText,
  formatMoney,
  parseMoneyToCents,
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
export function Totals({ inputs }) {
  const buyIns = inputs.reduce((s, p) => s + p.buyIns, 0);
  const chips = inputs.reduce(
    (s, p) => s + (parseMoneyToCents(p.finalChips) ?? 0),
    0,
  );
  return (
    <div className="totals">
      <div>
        <span>Buy-ins</span>
        <strong>{buyIns}</strong>
      </div>
      <div>
        <span>Collected</span>
        <strong>{formatMoney(buyIns * 1500)}</strong>
      </div>
      <div>
        <span>Final chips</span>
        <strong>{formatMoney(chips)}</strong>
      </div>
      <div>
        <span>Variance</span>
        <Amount cents={chips - buyIns * 1500} />
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
