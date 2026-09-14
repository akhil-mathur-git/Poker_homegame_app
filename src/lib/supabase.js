import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const configured = Boolean(url && key);
export let configurationError = "";
export let supabase = null;
if (configured) {
  try {
    if (key.startsWith("sb_secret_"))
      throw new Error("Use a public publishable/anon key, never a secret key.");
    if (key.startsWith("eyJ")) {
      const payload = JSON.parse(
        atob(key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
      );
      if (payload.role === "service_role")
        throw new Error(
          "Remove the service-role key. Use the public anon key.",
        );
    }
    supabase = createClient(url, key);
  } catch (error) {
    configurationError = error.message;
  }
}
let sessionPromise;
export function ensureSession() {
  if (!sessionPromise)
    sessionPromise = (async () => {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      if (data.session) return data.session;
      const response = await supabase.auth.signInAnonymously();
      if (response.error) throw response.error;
      return response.data.session;
    })().finally(() => {
      sessionPromise = null;
    });
  return sessionPromise;
}
export async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return data;
}
// Existing homegames SELECT RLS returns only memberships of auth.uid().
export async function loadHomegames() {
  const { data, error } = await supabase
    .from("homegames")
    .select("id,name,created_at,created_by")
    .order("created_at")
    .order("id");
  if (error) throw error;
  return data;
}
export async function loadData(homegameId) {
  // One RPC gives a transaction-consistent snapshot, including completion outputs.
  return rpc("get_homegame_data", { p_homegame: homegameId });
}
export function inputsForGame(game, data) {
  return data.game_players
    .filter((p) => p.game_id === game.id)
    .sort((a, b) => a.player_id.localeCompare(b.player_id))
    .map((p) => ({
      id: p.player_id,
      name: p.player_name_snapshot,
      buyIns: p.buy_ins,
      amountIn: (p.amount_in_cents / 100).toFixed(2),
      resultEntryMode: p.result_entry_mode,
      resultEntry:
        p.result_entry_cents === null
          ? ""
          : (p.result_entry_cents / 100).toFixed(2),
      inputRevision: p.input_revision,
    }));
}
export function savedSettlement(game, data) {
  return {
    results: data.game_players
      .filter((p) => p.game_id === game.id)
      .map((p) => ({
        id: p.player_id,
        name: p.player_name_snapshot,
        buyIns: p.buy_ins,
        finalChipsCents: p.final_chips_cents,
        amountPaidCents: p.amount_paid_cents,
        rawResultCents: p.raw_result_cents,
        adjustmentCents: p.variance_adjustment_cents,
        adjustedResultCents: p.final_result_cents,
      })),
    payments: data.settlements
      .filter((p) => p.game_id === game.id)
      .map((p) => ({
        fromId: p.from_player_id,
        toId: p.to_player_id,
        fromName: p.from_player_name_snapshot,
        toName: p.to_player_name_snapshot,
        amountCents: p.amount_cents,
      })),
    totals: {
      totalBuyIns: game.total_buy_ins,
      totalMoneyCollectedCents: game.total_collected_cents,
      totalFinalChipsCents: game.total_final_chips_cents,
      discrepancyCents: game.variance_cents,
    },
  };
}
