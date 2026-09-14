export function playerStatistics(playerId, data) {
  const games = new Map(
    data.games.filter((g) => g.status === "completed").map((g) => [g.id, g]),
  );
  const entries = data.game_players
    .filter((p) => p.player_id === playerId && games.has(p.game_id))
    .sort(
      (a, b) =>
        games
          .get(a.game_id)
          .game_date.localeCompare(games.get(b.game_id).game_date) ||
        games
          .get(a.game_id)
          .created_at.localeCompare(games.get(b.game_id).created_at) ||
        a.game_id.localeCompare(b.game_id),
    );
  let cumulative = 0;
  const timeline = entries.map((p) => ({
    date: games.get(p.game_id).game_date,
    name: games.get(p.game_id).name,
    result: p.final_result_cents,
    cumulative: (cumulative += p.final_result_cents),
  }));
  const results = entries.map((p) => p.final_result_cents);
  const wins = results.filter((r) => r > 0).length;
  return {
    games: entries.length,
    net: cumulative,
    average: entries.length ? Math.round(cumulative / entries.length) : 0,
    buyIns: entries.reduce((s, p) => s + (p.buy_ins ?? 0), 0),
    paid: entries.reduce((s, p) => s + p.amount_paid_cents, 0),
    biggestWin: Math.max(0, ...results),
    biggestLoss: Math.min(0, ...results),
    wins,
    losses: results.filter((r) => r < 0).length,
    winPercentage: entries.length
      ? Math.round((wins / entries.length) * 100)
      : 0,
    timeline,
  };
}
export function leaderboard(data) {
  return data.players
    .map((p) => ({ ...p, ...playerStatistics(p.id, data) }))
    .filter((p) => p.games > 0)
    .sort((a, b) => b.net - a.net || a.name.localeCompare(b.name));
}
