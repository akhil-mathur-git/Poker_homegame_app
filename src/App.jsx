import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import {
  configurationError,
  ensureSession,
  loadData,
  loadHomegame,
  rpc,
  supabase,
} from "./lib/supabase.js";
import { buildBackup, downloadJson, readLegacy } from "./lib/backup.js";
import { leaderboard } from "./lib/statistics.js";
import { formatMoney } from "./calculations.js";
import GameView from "./components/GameView.jsx";
import PlayersView, { AddPlayer } from "./components/PlayersView.jsx";
import { Amount } from "./components/Results.jsx";

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const emptyData = { players: [], games: [], game_players: [], settlements: [] };
function friendly(error) {
  if (error.code === "23505")
    return "That player name or active game already exists. Refresh to see the latest shared data.";
  if (error.code === "23514")
    return "Check the input limits: names cannot be blank, buy-ins must be 0–10,000, and chips $0–$1,000,000.";
  return (
    error.message ||
    "Could not reach the database. Your changes were not confirmed. Check your connection and retry."
  );
}
function Setup() {
  return (
    <main className="app-shell setup">
      <span className="brand-symbol">♠</span>
      <h1>Poker Homegame</h1>
      <section className="card">
        <h2>Connect your homegame</h2>
        <p>This app needs a Supabase project to share games across devices.</p>
        {configurationError && (
          <p className="error" role="alert">
            {configurationError}
          </p>
        )}
        <ol>
          <li>
            Follow the project’s <code>README.md</code> setup guide.
          </li>
          <li>
            Run <code>supabase/schema.sql</code> in Supabase.
          </li>
          <li>
            Copy <code>.env.example</code> to <code>.env.local</code> and add
            your project URL and public key.
          </li>
          <li>
            Restart <code>npm run dev</code>.
          </li>
        </ol>
        <p className="muted">
          Existing V1 data on this browser stays untouched.
        </p>
      </section>
    </main>
  );
}
function Onboarding({ run, busy, onJoined }) {
  const [name, setName] = useState("Poker Homegame"),
    [code, setCode] = useState("");
  return (
    <section className="onboarding">
      <h1>Join your table</h1>
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            await rpc("join_homegame_by_code", { p_code: code });
            await onJoined();
          });
        }}
      >
        <h2>Join a homegame</h2>
        <label>
          Invite code
          <input
            autoCapitalize="characters"
            autoComplete="off"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Paste your friend’s invite code"
          />
        </label>
        <button className="primary full" disabled={busy || !code.trim()}>
          Join homegame
        </button>
      </form>
      <p className="divider">or start a new table</p>
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            await rpc("create_homegame", { p_name: name });
            await onJoined();
          });
        }}
      >
        <label>
          Homegame name
          <input
            maxLength={80}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <button className="full" disabled={busy || !name.trim()}>
          Create homegame
        </button>
      </form>
      <p className="muted">
        No account signup. This browser remembers your membership. You don’t
        need to select yourself as a player.
      </p>
    </section>
  );
}
function GameList({ games, data, onOpen }) {
  return (
    <div className="list">
      {games.map((g) => (
        <button className="list-row" key={g.id} onClick={() => onOpen(g.id)}>
          <div>
            <strong>{g.name}</strong>
            <small>
              {g.game_date} ·{" "}
              {data.game_players.filter((p) => p.game_id === g.id).length}{" "}
              players
            </small>
            <small>
              Variance {formatMoney(g.variance_cents ?? 0, { signed: true })}
            </small>
          </div>
          <div className="align-right">
            <strong>{formatMoney(g.total_collected_cents ?? 0)}</strong>
            <small>View →</small>
          </div>
        </button>
      ))}
    </div>
  );
}
function NewGame({ homegame, data, run, busy, refresh, onOpen }) {
  const [name, setName] = useState("Sunday Poker"),
    [date, setDate] = useState(today),
    [selected, setSelected] = useState([]);
  return (
    <>
      <h1>New game</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const id = await rpc("start_game", {
              p_homegame: homegame.id,
              p_name: name,
              p_date: date,
              p_players: selected,
            });
            await refresh();
            onOpen(id);
          });
        }}
      >
        <div className="form-grid">
          <label>
            Game name
            <input
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Date
            <input
              type="date"
              required
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
        </div>
        <h2>Who’s playing?</h2>
        <div className="list">
          {data.players
            .filter((p) => !p.archived)
            .map((p) => (
              <label className="check list-row" key={p.id}>
                <span>{p.name}</span>
                <input
                  type="checkbox"
                  checked={selected.includes(p.id)}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? [...selected, p.id]
                        : selected.filter((id) => id !== p.id),
                    )
                  }
                />
              </label>
            ))}
        </div>
        <p className="muted">
          {selected.length} selected · Each starts with one $15 buy-in.
        </p>
        <button
          className="primary full"
          disabled={busy || selected.length < 2 || selected.length > 22}
        >
          Start game
        </button>
      </form>
      <AddPlayer
        homegameId={homegame.id}
        run={run}
        busy={busy}
        refresh={refresh}
        onAdded={(id) => setSelected((s) => [...s, id])}
      />
    </>
  );
}
function Settings({ homegame, run, busy }) {
  const [code, setCode] = useState(""),
    [message, setMessage] = useState("");
  const legacy = readLegacy();
  return (
    <>
      <h1>Settings & invite</h1>
      <section className="card">
        <h2>{homegame.name}</h2>
        <p className="muted">
          Anyone you share this code with can join, edit games, and view this
          homegame’s history.
        </p>
        {code && <code className="invite-code">{code}</code>}
        <button
          disabled={busy}
          onClick={() =>
            run(async () => {
              const value =
                code ||
                (await rpc("get_invite_code", { p_homegame: homegame.id }));
              setCode(value);
              try {
                await navigator.clipboard.writeText(value);
                setMessage("Copied!");
              } catch {
                setMessage("Select and copy the code above.");
              }
            })
          }
        >
          {code ? "Copy invite code" : "Show & copy invite code"}
        </button>
        <p role="status">{message}</p>
        <p className="muted">
          Keep this code somewhere safe. If browser data is cleared, rejoin with
          it. Your shared games remain in the database.
        </p>
      </section>
      <section className="card">
        <h2>Backup</h2>
        <p className="muted">
          Download all players and completed games, with their saved results and
          payments. Active games and invite codes are excluded.
        </p>
        <button
          disabled={busy}
          onClick={() =>
            run(async () => {
              const latest = await loadData(homegame.id);
              downloadJson(
                buildBackup(homegame, latest),
                `poker-homegame-backup-${today()}.json`,
              );
            })
          }
        >
          Export backup
        </button>
      </section>
      {legacy && (
        <section className="card">
          <h2>Previous device-local game</h2>
          <p className="muted">
            V1 saved only a draft, with no game date or completion record.
            Export it for reference, then enter it as a new game if you want it
            in shared history. It will never overwrite cloud data automatically.
          </p>
          <button
            onClick={() =>
              downloadJson(
                { schemaVersion: 1, players: legacy },
                `poker-v1-draft-${today()}.json`,
              )
            }
          >
            Export V1 draft
          </button>
        </section>
      )}
    </>
  );
}
export default function App() {
  const [homegame, setHomegame] = useState(null),
    [data, setData] = useState(emptyData),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [view, setView] = useState("home"),
    [gameId, setGameId] = useState(null),
    [connection, setConnection] = useState("Connecting"),
    [online, setOnline] = useState(navigator.onLine);
  const request = useRef(0),
    operation = useRef(false),
    unsaved = useRef(false);
  const markDirty = useCallback((value) => {
    unsaved.current = value;
  }, []);
  const refresh = useCallback(async () => {
    if (!homegame) return;
    const sequence = ++request.current;
    const next = await loadData(homegame.id);
    if (sequence === request.current) setData(next);
  }, [homegame]);
  const initialize = useCallback(async () => {
    await ensureSession();
    const group = await loadHomegame();
    if (group) {
      const next = await loadData(group.id);
      setData(next);
    }
    setHomegame(group);
    setLoading(false);
  }, []);
  const run = useCallback(async (fn) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(friendly(e));
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    if (!supabase) return;
    let alive = true;
    ensureSession()
      .then(async () => {
        const group = await loadHomegame();
        const next = group ? await loadData(group.id) : emptyData;
        if (alive) {
          setHomegame(group);
          setData(next);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (alive) {
          setError(friendly(e));
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [initialize]);
  useEffect(() => {
    if (!homegame || !supabase) return;
    let timer,
      alive = true;
    const update = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () =>
          refresh().catch((e) => {
            if (alive) setError(friendly(e));
          }),
        120,
      );
    };
    const channel = supabase
      .channel(`homegame-${homegame.id}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "homegames",
          filter: `id=eq.${homegame.id}`,
        },
        update,
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "games",
          filter: `homegame_id=eq.${homegame.id}`,
        },
        update,
      )
      .subscribe((status) => {
        if (alive) {
          setConnection(
            status === "SUBSCRIBED"
              ? "Live"
              : status === "CHANNEL_ERROR" || status === "TIMED_OUT"
                ? "Live updates unavailable"
                : "Connecting",
          );
          if (status === "SUBSCRIBED") update();
        }
      });
    const resume = () => {
      setOnline(navigator.onLine);
      if (navigator.onLine) update();
    };
    const visible = () => {
      if (document.visibilityState === "visible") resume();
    };
    window.addEventListener("online", resume);
    window.addEventListener("offline", resume);
    document.addEventListener("visibilitychange", visible);
    // Small fallback refresh: recovers missed events after mobile suspension or socket failure.
    const interval = setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine) update();
    }, 30000);
    return () => {
      alive = false;
      clearTimeout(timer);
      clearInterval(interval);
      supabase.removeChannel(channel);
      window.removeEventListener("online", resume);
      window.removeEventListener("offline", resume);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [homegame, refresh]);
  if (!supabase) return <Setup />;
  const openGame = (id) => {
    setGameId(id);
    setView("game");
    setError("");
    window.scrollTo(0, 0);
  };
  const navigate = (next) => {
    if (
      unsaved.current &&
      !window.confirm("Leave this view? Unsaved inputs will be lost.")
    )
      return;
    setView(next);
    setError("");
    window.scrollTo(0, 0);
  };
  const current = data.games.find((g) => g.status === "active"),
    completed = data.games.filter((g) => g.status === "completed"),
    game = data.games.find((g) => g.id === gameId);
  return (
    <div className="app-shell">
      <header className="app-header">
        <button className="brand" onClick={() => navigate("home")}>
          <span className="brand-symbol" aria-hidden="true">
            ♠
          </span>
          <span>
            Poker Homegame<small>{homegame?.name || "Your shared table"}</small>
          </span>
        </button>
        {homegame && (
          <button
            aria-label="Settings and invite"
            onClick={() => navigate("settings")}
          >
            Invite / Settings
          </button>
        )}
      </header>
      {homegame && (
        <div className="connection">
          <span
            className={
              online && connection === "Live" ? "live-dot" : "offline-dot"
            }
          />
          <span>{!online ? "Offline · changes may fail" : connection}</span>
          <button
            className="small"
            disabled={busy}
            onClick={() => run(refresh)}
          >
            Refresh
          </button>
          {busy && <span role="status">Saving / loading…</span>}
        </div>
      )}
      {error && (
        <div className="error" role="alert">
          <p>{error}</p>
          <button
            disabled={busy}
            onClick={() => run(homegame ? refresh : initialize)}
          >
            Retry loading
          </button>
        </div>
      )}
      <main>
        {loading ? (
          <section className="empty" role="status">
            Connecting to your homegame…
          </section>
        ) : !homegame ? (
          <Onboarding run={run} busy={busy} onJoined={initialize} />
        ) : (
          <>
            {view === "home" && (
              <>
                <div className="section-head">
                  <h1>Home</h1>
                  <button
                    className="primary"
                    disabled={busy || !!current}
                    onClick={() => navigate("new")}
                  >
                    + New game
                  </button>
                </div>
                {current ? (
                  <section className="card current-game">
                    <p className="kicker">Current game</p>
                    <h2>{current.name}</h2>
                    <p className="muted">
                      {
                        data.game_players.filter(
                          (p) => p.game_id === current.id,
                        ).length
                      }{" "}
                      players ·{" "}
                      {formatMoney(
                        data.game_players
                          .filter((p) => p.game_id === current.id)
                          .reduce((s, p) => s + p.buy_ins * 1500, 0),
                      )}{" "}
                      collected
                    </p>
                    <button
                      className="primary full"
                      onClick={() => openGame(current.id)}
                    >
                      Continue game →
                    </button>
                  </section>
                ) : (
                  <p className="empty">
                    No active game. Start one when everyone’s ready.
                  </p>
                )}
                <div className="section-head">
                  <h2>Recent games</h2>
                  <button className="small" onClick={() => navigate("history")}>
                    View all
                  </button>
                </div>
                <GameList
                  games={completed.slice(0, 3)}
                  data={data}
                  onOpen={openGame}
                />
                {!completed.length && (
                  <p className="empty">Completed games will appear here.</p>
                )}
                <h2>All-time leaderboard</h2>
                <div className="list">
                  {leaderboard(data).map((p, i) => (
                    <div className="list-row" key={p.id}>
                      <span>
                        <span className="rank">{i + 1}</span>
                        {p.name}
                      </span>
                      <Amount cents={p.net} />
                    </div>
                  ))}
                </div>
                <p className="muted">
                  Based on final adjusted results from completed games.
                </p>
              </>
            )}
            {view === "new" &&
              (current ? (
                <section className="card">
                  <h2>A game is already active</h2>
                  <button onClick={() => openGame(current.id)}>
                    Continue {current.name}
                  </button>
                </section>
              ) : (
                <NewGame
                  homegame={homegame}
                  data={data}
                  run={run}
                  busy={busy}
                  refresh={refresh}
                  onOpen={openGame}
                />
              ))}
            {view === "game" &&
              (game ? (
                <GameView
                  key={game.id}
                  game={game}
                  data={data}
                  run={run}
                  busy={busy}
                  refresh={refresh}
                  goHome={() => navigate("home")}
                  markDirty={markDirty}
                />
              ) : (
                <p className="empty">
                  This game was deleted.{" "}
                  <button onClick={() => navigate("home")}>Return home</button>
                </p>
              ))}
            {view === "history" && (
              <>
                <h1>History</h1>
                <GameList games={completed} data={data} onOpen={openGame} />
                {!completed.length && (
                  <p className="empty">No completed games yet.</p>
                )}
              </>
            )}
            {view === "players" && (
              <PlayersView
                homegameId={homegame.id}
                data={data}
                run={run}
                busy={busy}
                refresh={refresh}
              />
            )}
            {view === "settings" && (
              <Settings homegame={homegame} run={run} busy={busy} />
            )}
          </>
        )}
      </main>
      {homegame && (
        <nav className="bottom-nav" aria-label="Main navigation">
          {[
            ["home", "⌂", "Home"],
            ["players", "♙", "Players"],
            ["history", "◷", "History"],
          ].map(([id, icon, label]) => (
            <button
              key={id}
              aria-current={view === id ? "page" : undefined}
              onClick={() => navigate(id)}
            >
              <span aria-hidden="true">{icon}</span>
              {label}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
