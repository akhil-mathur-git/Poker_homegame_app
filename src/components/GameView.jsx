import { useEffect, useState } from "react";
import {
  calculateSettlement,
  derivePlayer,
  formatMoney,
  gameBuyIn,
  parseMoneyToCents,
} from "../calculations.js";
import { inputsForGame, rpc, savedSettlement } from "../lib/supabase.js";
import Results, { Amount, Totals } from "./Results.jsx";

export default function GameView({
  game,
  data,
  run,
  busy,
  refresh,
  goHome,
  markDirty,
}) {
  const [editing, setEditing] = useState(null),
    [drafts, setDrafts] = useState({}),
    [preview, setPreview] = useState(null);
  const liveInputs = inputsForGame(game, data),
    inputs = editing?.inputs ?? liveInputs;
  const dirty = Object.keys(drafts).length > 0;
  const { mode, value } = gameBuyIn(game);
  useEffect(() => {
    const unsaved = dirty || Boolean(editing);
    markDirty(unsaved);
    const warn = (e) => {
      if (unsaved) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      markDirty(false);
      window.removeEventListener("beforeunload", warn);
    };
  }, [dirty, editing, markDirty]);
  const editConflict = editing && editing.revision !== game.revision;
  const validPreview =
    preview && preview.revision === (editing?.revision ?? game.revision);
  function change(p, patch) {
    setPreview(null);
    if (editing)
      setEditing((current) => ({
        ...current,
        inputs: current.inputs.map((x) =>
          x.id === p.id ? { ...x, ...patch } : x,
        ),
      }));
    else
      setDrafts((current) => ({
        ...current,
        [p.id]: {
          ...current[p.id],
          ...patch,
          expectedRevision: current[p.id]?.expectedRevision ?? p.inputRevision,
        },
      }));
  }
  function discard(id) {
    setDrafts((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }
  async function save(p) {
    const draft = drafts[p.id],
      entry = { ...p, ...draft };
    const derived = derivePlayer(entry, game);
    await rpc("save_game_entry", {
      p_game: game.id,
      p_player: p.id,
      p_revision: draft.expectedRevision,
      p_amount: draft.amountDirty ? parseMoneyToCents(entry.amountIn) : null,
      p_save_result: !!draft.resultDirty,
      p_result_mode: draft.resultDirty ? entry.resultEntryMode : null,
      p_result_cents: draft.resultDirty ? derived.resultEntryCents : null,
    });
    discard(p.id);
    await refresh();
  }
  async function complete() {
    await rpc("complete_game", {
      p_game: game.id,
      p_revision: preview.revision,
      p_name: editing?.name ?? game.name,
      p_date: editing?.date ?? game.game_date,
      p_inputs: preview.settlement.results.map((p) => ({
        id: p.id,
        buyIns: p.buyIns,
        amountInCents: p.amountInCents,
        resultEntryMode: p.resultEntryMode,
        resultEntryCents: p.resultEntryCents,
      })),
      p_payments: preview.settlement.payments,
    });
    await refresh();
    markDirty(false);
    goHome();
  }
  return (
    <>
      <div className="section-head">
        <div>
          <p className="kicker">
            {editing
              ? "Correcting history"
              : game.status === "active"
                ? "Current game"
                : "Completed game"}
          </p>
          <h1>{game.name}</h1>
          <p className="muted">
            {game.game_date} · {inputs.length} players ·{" "}
            {mode === "fixed"
              ? `${formatMoney(value)} fixed buy-ins`
              : "Flexible amount"}
          </p>
        </div>
        <button onClick={goHome}>Back</button>
      </div>
      {editing && (
        <div className="card form-grid">
          <label>
            Game name
            <input
              value={editing.name}
              maxLength={80}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
          </label>
          <label>
            Date
            <input
              type="date"
              value={editing.date}
              onChange={(e) => setEditing({ ...editing, date: e.target.value })}
            />
          </label>
          <p className="muted">
            This game keeps its original buy-in tracking. Corrections are saved
            only when you recalculate and save.
          </p>
        </div>
      )}
      {editConflict && (
        <p className="notice" role="alert">
          This game changed on another device. Note your corrections, cancel
          this edit, then reopen it.
        </p>
      )}
      {game.status === "active" || editing ? (
        <>
          <Totals
            inputs={inputs.map((p) => ({ ...p, ...drafts[p.id] }))}
            game={game}
          />
          {dirty && (
            <p className="notice">
              Entries marked “Unsaved” are still on this device. Save each
              before calculating.
            </p>
          )}
          <div className="cards">
            {inputs.map((p) => {
              const entry = { ...p, ...drafts[p.id] };
              let derived = null,
                validation = "";
              try {
                derived = derivePlayer(entry, game);
              } catch (e) {
                validation = e.message;
              }
              const resultValue = (field) =>
                entry.resultEntryMode === field
                  ? entry.resultEntry
                  : derived?.finalChipsCents == null
                    ? ""
                    : (
                        (field === "final_chips"
                          ? derived.finalChipsCents
                          : derived.rawResultCents) / 100
                      ).toFixed(2);
              return (
                <article className="card" key={p.id}>
                  <div className="section-head">
                    <h3>{p.name}</h3>
                    {editing && (
                      <button
                        className="small danger"
                        disabled={busy}
                        onClick={() => {
                          setEditing({
                            ...editing,
                            inputs: inputs.filter((x) => x.id !== p.id),
                          });
                          setPreview(null);
                        }}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  <div className="entry-controls amount-controls">
                    {mode === "fixed" ? (
                      <>
                        <div>
                          <span className="field-label">Buy-ins</span>
                          <div className="stepper">
                            {[-1, 1].map((delta) => (
                              <button
                                key={delta}
                                aria-label={`${delta < 0 ? "Decrease" : "Increase"} buy-ins for ${p.name}`}
                                disabled={
                                  busy ||
                                  (!editing && !!drafts[p.id]) ||
                                  (delta < 0
                                    ? p.buyIns === 0
                                    : p.buyIns >= 10000)
                                }
                                onClick={() =>
                                  editing
                                    ? change(p, { buyIns: p.buyIns + delta })
                                    : run(async () => {
                                        await rpc("update_game_input", {
                                          p_game: game.id,
                                          p_player: p.id,
                                          p_delta: delta,
                                        });
                                        await refresh();
                                      })
                                }
                              >
                                {delta < 0 ? "−" : "+"}
                              </button>
                            ))}
                            <strong>{p.buyIns}</strong>
                          </div>
                        </div>
                        <div>
                          <span className="field-label">Amount in</span>
                          <strong className="amount-in">
                            {formatMoney(p.buyIns * value)}
                          </strong>
                        </div>
                      </>
                    ) : (
                      <label>
                        Amount in ($)
                        <input
                          aria-label={`Amount in for ${p.name}`}
                          inputMode="decimal"
                          value={entry.amountIn}
                          disabled={busy}
                          onChange={(e) => {
                            if (/^\d*(?:\.\d{0,2})?$/.test(e.target.value))
                              change(p, {
                                amountIn: e.target.value,
                                amountDirty: true,
                              });
                          }}
                        />
                      </label>
                    )}
                  </div>
                  <div className="entry-controls linked-results">
                    {[
                      ["final_chips", "Final chips"],
                      ["net_pl", "Net P/L"],
                    ].map(([field, label]) => (
                      <label
                        key={field}
                        className={
                          entry.resultEntryMode === field
                            ? "source-field"
                            : "companion-field"
                        }
                      >
                        {label} ($)
                        <input
                          aria-label={`${label} for ${p.name}`}
                          inputMode={field === "net_pl" ? "text" : "decimal"}
                          value={resultValue(field)}
                          disabled={busy}
                          onChange={(e) => {
                            if (/^[+-]?\d*(?:\.\d{0,2})?$/.test(e.target.value))
                              change(p, {
                                resultEntryMode: field,
                                resultEntry: e.target.value,
                                resultDirty: true,
                              });
                          }}
                        />
                        <small>
                          {entry.resultEntryMode === field
                            ? "Entered source"
                            : "Calculated · editable"}
                        </small>
                      </label>
                    ))}
                  </div>
                  {validation && (
                    <p className="negative input-error" role="status">
                      {validation}
                    </p>
                  )}
                  {!validation && derived?.resultEntryCents === null && (
                    <p className="muted input-error">Result not entered</p>
                  )}
                  {!editing && drafts[p.id] && (
                    <div className="actions">
                      <span className="muted">Unsaved</span>
                      <button
                        disabled={busy || !!validation}
                        onClick={() => run(() => save(p))}
                      >
                        Save entry
                      </button>
                      <button disabled={busy} onClick={() => discard(p.id)}>
                        Discard
                      </button>
                    </div>
                  )}
                  <div className="row-summary">
                    <span>
                      Amount in{" "}
                      {derived ? formatMoney(derived.amountPaidCents) : "—"}
                    </span>
                    <span>
                      Raw{" "}
                      {derived?.rawResultCents == null ? (
                        "—"
                      ) : (
                        <Amount cents={derived.rawResultCents} />
                      )}
                    </span>
                  </div>
                </article>
              );
            })}
          </div>
          {editing && (
            <label className="add-participant">
              Add participant
              <select
                value=""
                onChange={(e) => {
                  const p = data.players.find((x) => x.id === e.target.value);
                  if (p) {
                    setEditing({
                      ...editing,
                      inputs: [
                        ...inputs,
                        {
                          id: p.id,
                          name: p.name,
                          buyIns: mode === "fixed" ? 1 : null,
                          amountIn: "0.00",
                          resultEntryMode: "final_chips",
                          resultEntry: "",
                        },
                      ],
                    });
                    setPreview(null);
                  }
                }}
              >
                <option value="">Select player…</option>
                {data.players
                  .filter(
                    (p) => !p.archived && !inputs.some((x) => x.id === p.id),
                  )
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <div className="actions">
            <button
              className="primary grow"
              disabled={busy || dirty}
              onClick={() =>
                run(async () =>
                  setPreview({
                    settlement: calculateSettlement(inputs, game),
                    revision: editing?.revision ?? game.revision,
                  }),
                )
              }
            >
              Calculate settlement
            </button>
            {editing && (
              <button
                disabled={busy}
                onClick={() => {
                  if (window.confirm("Discard this correction?")) {
                    setEditing(null);
                    setPreview(null);
                  }
                }}
              >
                Cancel edit
              </button>
            )}
          </div>
          {preview && !validPreview && (
            <p className="notice">
              The game changed. Calculate again to review the latest settlement.
            </p>
          )}
          {validPreview && !dirty && (
            <>
              <Results
                settlement={preview.settlement}
                name={editing?.name ?? game.name}
              />
              <button
                className="primary full"
                disabled={busy || editConflict}
                onClick={() => run(complete)}
              >
                {editing ? "Save corrected game" : "Complete & save game"}
              </button>
            </>
          )}
        </>
      ) : (
        <>
          <Results settlement={savedSettlement(game, data)} name={game.name} />
          <button
            onClick={() => {
              setEditing({
                name: game.name,
                date: game.game_date,
                inputs: liveInputs,
                revision: game.revision,
              });
              setPreview(null);
            }}
          >
            Edit game
          </button>
        </>
      )}
      <div className="danger-zone">
        <button
          className="danger"
          disabled={busy}
          onClick={() => {
            if (
              window.confirm(
                `Delete “${game.name}” and all its results? This cannot be undone.`,
              )
            )
              run(async () => {
                await rpc("delete_game", {
                  p_game: game.id,
                  p_revision: game.revision,
                });
                await refresh();
                markDirty(false);
                goHome();
              });
          }}
        >
          Delete {game.status === "active" ? "active " : ""}game
        </button>
      </div>
    </>
  );
}
