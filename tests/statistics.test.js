import test from "node:test";
import assert from "node:assert/strict";
import { playerStatistics, leaderboard } from "../src/lib/statistics.js";
import { buildBackup } from "../src/lib/backup.js";
const data = {
  players: [
    { id: "a", name: "A", archived: true },
    { id: "b", name: "B" },
  ],
  games: [
    {
      id: "2",
      status: "completed",
      game_date: "2026-09-12",
      created_at: "2",
      name: "Two",
    },
    {
      id: "1",
      status: "completed",
      game_date: "2026-09-01",
      created_at: "1",
      name: "One",
    },
    { id: "3", status: "active" },
  ],
  game_players: [
    {
      player_id: "a",
      game_id: "2",
      final_result_cents: -1000,
      buy_ins: 2,
      amount_paid_cents: 3000,
    },
    {
      player_id: "a",
      game_id: "1",
      final_result_cents: 2000,
      buy_ins: 1,
      amount_paid_cents: 1500,
    },
    { player_id: "a", game_id: "3", final_result_cents: 99999 },
  ],
  settlements: [{ game_id: "1" }, { game_id: "3" }],
};
test("statistics use completed adjusted results in chronological order", () => {
  const s = playerStatistics("a", data);
  assert.equal(s.games, 2);
  assert.equal(s.net, 1000);
  assert.equal(s.average, 500);
  assert.equal(s.buyIns, 3);
  assert.equal(s.paid, 4500);
  assert.equal(s.winPercentage, 50);
  assert.deepEqual(
    s.timeline.map((p) => p.cumulative),
    [2000, 1000],
  );
  assert.equal(leaderboard(data)[0].id, "a");
});
test("corrections and deletions naturally change statistics", () => {
  const changed = structuredClone(data);
  changed.game_players[0].final_result_cents = -3000;
  assert.equal(playerStatistics("a", changed).net, -1000);
  changed.games = changed.games.filter((g) => g.id !== "1");
  assert.equal(playerStatistics("a", changed).net, -3000);
});
test("backup excludes active game and membership/invite secrets", () => {
  const b = buildBackup(
    { id: "h", name: "Table", invite_code: "secret" },
    data,
  );
  assert.equal(b.schemaVersion, 2);
  assert.equal(b.games.length, 2);
  assert.equal(b.game_players.length, 2);
  assert.equal(b.settlements.length, 1);
  assert.deepEqual(b.homegame, { id: "h", name: "Table" });
});
