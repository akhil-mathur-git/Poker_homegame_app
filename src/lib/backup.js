export function buildBackup(homegame, data) {
  const games = data.games.filter((g) => g.status === "completed");
  const ids = new Set(games.map((g) => g.id));
  return {
    schemaVersion: 3,
    exportedAt: new Date().toISOString(),
    homegame: { id: homegame.id, name: homegame.name },
    players: data.players,
    games,
    game_players: data.game_players.filter((p) => ids.has(p.game_id)),
    settlements: data.settlements.filter((p) => ids.has(p.game_id)),
  };
}
export function downloadJson(value, filename) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function readLegacy() {
  try {
    const value = JSON.parse(localStorage.getItem("poker-homegame-v1"));
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
