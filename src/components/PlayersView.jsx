import { useState } from "react";
import { rpc } from "../lib/supabase.js";
import { playerStatistics } from "../lib/statistics.js";
import { formatMoney } from "../calculations.js";
import { Amount } from "./Results.jsx";

export function AddPlayer({
  homegameId,
  run,
  busy,
  refresh,
  onAdded = () => {},
}) {
  const [name, setName] = useState("");
  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          const id = await rpc("save_player", {
            p_homegame: homegameId,
            p_name: name,
          });
          setName("");
          await refresh();
          onAdded(id);
        });
      }}
    >
      <label className="grow">
        New player
        <input
          required
          maxLength={40}
          placeholder="Player name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <button disabled={busy || !name.trim()} type="submit">
        + Add
      </button>
    </form>
  );
}
function Chart({ timeline }) {
  if (!timeline.length)
    return <p className="empty">Complete a game to start this chart.</p>;
  const values = [0, ...timeline.map((p) => p.cumulative)];
  const min = Math.min(...values),
    max = Math.max(...values),
    range = max - min || 100;
  const y = (v) => 145 - ((v - min) / range) * 120;
  const x = (i) => 65 + (i / (values.length - 1)) * 245;
  return (
    <figure className="chart">
      <svg
        viewBox="0 0 330 180"
        role="img"
        aria-label={`Cumulative adjusted profit over ${timeline.length} games, ending at ${formatMoney(values.at(-1))}`}
      >
        <line
          x1="65"
          x2="310"
          y1={y(0)}
          y2={y(0)}
          stroke="var(--muted)"
          strokeDasharray="3 4"
        />
        {[...new Set([min, max, 0])].map((v) => (
          <text key={v} x="59" y={y(v) + 4} textAnchor="end">
            {formatMoney(v)}
          </text>
        ))}
        <polyline
          points={values.map((v, i) => `${x(i)},${y(v)}`).join(" ")}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2.5"
        />
        {timeline.map((p, i) => (
          <circle
            key={i}
            cx={x(i + 1)}
            cy={y(p.cumulative)}
            r="3"
            fill="var(--accent)"
          >
            <title>
              {p.date}: {formatMoney(p.cumulative)}
            </title>
          </circle>
        ))}
        <text x="65" y="172">
          Start
        </text>
        <text x="310" y="172" textAnchor="end">
          {timeline.at(-1).date}
        </text>
      </svg>
      <figcaption>Cumulative adjusted P/L · games in date order</figcaption>
    </figure>
  );
}
function Profile({ player, data, homegameId, run, busy, refresh, onBack }) {
  const [name, setName] = useState(player.name);
  const stats = playerStatistics(player.id, data);
  const items = [
    ["Games played", stats.games],
    ["Lifetime net", formatMoney(stats.net, { signed: true })],
    ["Average / game", formatMoney(stats.average, { signed: true })],
    ["Total buy-ins", stats.buyIns],
    ["Total bought in", formatMoney(stats.paid)],
    ["Biggest win", formatMoney(stats.biggestWin, { signed: true })],
    ["Biggest loss", formatMoney(stats.biggestLoss, { signed: true })],
    ["Winning games", stats.wins],
    ["Losing games", stats.losses],
    ["Win percentage", `${stats.winPercentage}%`],
  ];
  return (
    <>
      <div className="section-head">
        <h1>{player.name}</h1>
        <button onClick={onBack}>All players</button>
      </div>
      <div className="stats-grid">
        {items.map(([label, value]) => (
          <div className="card" key={label}>
            <span className="muted">{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <section className="card">
        <h2>Profit over time</h2>
        <Chart timeline={stats.timeline} />
      </section>
      <h2>Game results</h2>
      <div className="list">
        {[...stats.timeline].reverse().map((p, i) => (
          <div key={i} className="list-row">
            <div>
              {p.name}
              <small>{p.date}</small>
            </div>
            <Amount cents={p.result} />
          </div>
        ))}
        {!stats.games && <p className="empty">No completed games yet.</p>}
      </div>
      <h2>Manage player</h2>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            await rpc("save_player", {
              p_homegame: homegameId,
              p_id: player.id,
              p_name: name,
              p_archived: player.archived,
            });
            await refresh();
          });
        }}
      >
        <label className="grow">
          Name
          <input
            required
            maxLength={40}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <button disabled={busy || !name.trim()}>Rename</button>
      </form>
      <p className="muted">Old games keep the name recorded at the table.</p>
      <button
        disabled={busy}
        onClick={() =>
          run(async () => {
            await rpc("save_player", {
              p_homegame: homegameId,
              p_id: player.id,
              p_name: player.name,
              p_archived: !player.archived,
            });
            await refresh();
          })
        }
      >
        {player.archived ? "Restore player" : "Archive player"}
      </button>
      <p className="muted">
        Archived players keep their history and statistics.
      </p>
    </>
  );
}
export default function PlayersView(props) {
  const [selected, setSelected] = useState(null);
  const [archived, setArchived] = useState(false);
  const player = props.data.players.find((p) => p.id === selected);
  if (player)
    return (
      <Profile
        key={player.id}
        {...props}
        player={player}
        onBack={() => setSelected(null)}
      />
    );
  return (
    <>
      <h1>Players</h1>
      <AddPlayer {...props} />
      <label className="check">
        <input
          type="checkbox"
          checked={archived}
          onChange={(e) => setArchived(e.target.checked)}
        />
        Show archived players
      </label>
      <div className="list">
        {props.data.players
          .filter((p) => archived || !p.archived)
          .map((p) => (
            <button
              className="list-row"
              key={p.id}
              onClick={() => setSelected(p.id)}
            >
              <span>
                {p.name}
                {p.archived && <small>Archived</small>}
              </span>
              <span className="muted">Profile →</span>
            </button>
          ))}
      </div>
      {!props.data.players.length && (
        <p className="empty">
          Add your regular players. Everyone in the homegame shares this list.
        </p>
      )}
    </>
  );
}
