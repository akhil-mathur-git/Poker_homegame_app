import { useEffect, useState } from "react";
import {
  calculateSettlement,
  formatMoney,
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
  const [editing, setEditing] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [preview, setPreview] = useState(null);
  const liveInputs = inputsForGame(game, data);
  const inputs = editing?.inputs || liveInputs;
  const dirty = Object.keys(drafts).length > 0;
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
  function calculate() {
    return run(async () => {
      setPreview({
        settlement: calculateSettlement(inputs),
        inputs,
        revision: editing?.revision ?? game.revision,
      });
    });
  }
  function editInput(id, field, value) {
    setEditing((current) => ({
      ...current,
      inputs: current.inputs.map((p) =>
        p.id === id ? { ...p, [field]: value } : p,
      ),
    }));
    setPreview(null);
  }
  async function saveChips(p) {
    const draft = drafts[p.id];
    const cents = parseMoneyToCents(draft.value);
    if (cents === null || cents > 100000000)
      throw new Error(
        "Enter a chip amount from $0 to $1,000,000 with at most two decimal places.",
      );
    await rpc("update_game_input", {
      p_game: game.id,
      p_player: p.id,
      p_chips: cents,
      p_expected_chips: draft.expected,
    });
    setDrafts((current) => {
      const next = { ...current };
      delete next[p.id];
      return next;
    });
    setPreview(null);
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
        finalChipsCents: p.finalChipsCents,
      })),
      p_payments: preview.settlement.payments,
    });
    await refresh();
    markDirty(false);
    goHome();
  }
  const isEntry = game.status === "active" || editing;
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
            {game.game_date} · {inputs.length} players · $15 buy-in
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
            Your correction stays on this device until you save. If another
            member changes the game, saving will be rejected.
          </p>
        </div>
      )}
      {editConflict && (
        <p className="notice" role="alert">
          This game changed on another device. Note your corrections, cancel
          this edit, then reopen it to use the latest saved version.
        </p>
      )}
      {isEntry ? (
        <>
          <Totals inputs={inputs} />
          {dirty && (
            <p className="notice">
              Chip inputs marked “Unsaved” have not been saved to the shared
              game. Save each before calculating.
            </p>
          )}
          <div className="cards">
            {inputs.map((p) => {
              const value = editing
                ? p.finalChips
                : (drafts[p.id]?.value ?? p.finalChips);
              const chips = parseMoneyToCents(value);
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
                  <div className="entry-controls">
                    <div>
                      <span className="field-label">Buy-ins</span>
                      <div className="stepper">
                        <button
                          aria-label={`Decrease buy-ins for ${p.name}`}
                          disabled={busy || p.buyIns === 0}
                          onClick={() =>
                            editing
                              ? editInput(p.id, "buyIns", p.buyIns - 1)
                              : run(async () => {
                                  await rpc("update_game_input", {
                                    p_game: game.id,
                                    p_player: p.id,
                                    p_delta: -1,
                                  });
                                  await refresh();
                                })
                          }
                        >
                          −
                        </button>
                        <strong>{p.buyIns}</strong>
                        <button
                          aria-label={`Increase buy-ins for ${p.name}`}
                          disabled={busy || p.buyIns >= 10000}
                          onClick={() =>
                            editing
                              ? editInput(p.id, "buyIns", p.buyIns + 1)
                              : run(async () => {
                                  await rpc("update_game_input", {
                                    p_game: game.id,
                                    p_player: p.id,
                                    p_delta: 1,
                                  });
                                  await refresh();
                                })
                          }
                        >
                          +
                        </button>
                      </div>
                    </div>
                    <label>
                      Final chips ($)
                      <input
                        inputMode="decimal"
                        aria-label={`Final chips for ${p.name}`}
                        value={value}
                        disabled={busy}
                        onChange={(e) => {
                          if (!/^\d*(?:\.\d{0,2})?$/.test(e.target.value))
                            return;
                          if (editing)
                            editInput(p.id, "finalChips", e.target.value);
                          else
                            setDrafts((current) => ({
                              ...current,
                              [p.id]: {
                                value: e.target.value,
                                expected:
                                  current[p.id]?.expected ??
                                  parseMoneyToCents(p.finalChips),
                              },
                            }));
                        }}
                      />
                    </label>
                  </div>
                  {!editing && drafts[p.id] && (
                    <div className="actions">
                      <span className="muted">Unsaved</span>
                      <button
                        disabled={busy}
                        onClick={() => run(() => saveChips(p))}
                      >
                        Save chips
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          setDrafts((current) => {
                            const next = { ...current };
                            delete next[p.id];
                            return next;
                          })
                        }
                      >
                        Discard
                      </button>
                    </div>
                  )}
                  <div className="row-summary">
                    <span>Paid {formatMoney(p.buyIns * 1500)}</span>
                    <span>
                      Raw <Amount cents={(chips ?? 0) - p.buyIns * 1500} />
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
                disabled={busy}
                onChange={(e) => {
                  const p = data.players.find((p) => p.id === e.target.value);
                  if (p) {
                    setEditing({
                      ...editing,
                      inputs: [
                        ...inputs,
                        { id: p.id, name: p.name, buyIns: 1, finalChips: "" },
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
              onClick={calculate}
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
            disabled={busy}
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
