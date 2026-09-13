// Optional UI smoke test. Uses an intercepted database module, NOT hosted Supabase.
// PLAYWRIGHT_MODULE_PATH may point at an existing Playwright installation.
import { readFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE_PATH || "playwright"
);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const output = process.env.QA_OUTPUT_DIR || "/tmp/poker-homegame-qa";
await mkdir(output, { recursive: true });
const context = await browser.newContext({
  viewport: { width: 375, height: 812 },
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const base = process.env.QA_URL || "http://127.0.0.1:5173";
try {
  await page.goto(base);
  await page.getByRole("heading", { name: "Connect your homegame" }).waitFor();
  await page.screenshot({ path: `${output}/setup-375.png`, fullPage: true });
  const actual = await readFile(
    new URL("../src/lib/supabase.js", import.meta.url),
    "utf8",
  );
  const mock = `
    export const configurationError='';
    let group=null;let data={players:[],games:[],game_players:[],settlements:[]};
    export const supabase={channel:()=>({on(){return this},subscribe(cb){cb('SUBSCRIBED');return this}}),removeChannel(){}};
    export async function ensureSession(){return {user:{id:'test-device'}}}
    export async function loadHomegame(){return group}
    export async function loadData(){return structuredClone(data)}
    export async function rpc(name,p){
      if(name==='create_homegame'){group={id:'group',name:p.p_name};return 'group'}
      if(name==='save_player'){const id=p.p_id||crypto.randomUUID();const existing=data.players.find(x=>x.id===id);if(existing){existing.name=p.p_name;existing.archived=p.p_archived}else data.players.push({id,name:p.p_name,archived:false});return id}
      if(name==='start_game'){const id=crypto.randomUUID();data.games.push({id,name:p.p_name,game_date:p.p_date,created_at:new Date().toISOString(),status:'active',revision:0});data.game_players=p.p_players.map(player_id=>({game_id:id,player_id,player_name_snapshot:data.players.find(p=>p.id===player_id).name,buy_ins:1,final_chips_cents:0}));return id}
      if(name==='update_game_input'){const row=data.game_players.find(x=>x.player_id===p.p_player);if(p.p_chips!==undefined)row.final_chips_cents=p.p_chips;if(p.p_delta)row.buy_ins+=p.p_delta;data.games[0].revision++;return}
      if(name==='complete_game'){const {calculateSettlement}=await import('/src/calculations.js');const s=calculateSettlement(p.p_inputs.map(x=>({id:x.id,name:data.players.find(y=>y.id===x.id).name,buyIns:x.buyIns,finalChips:(x.finalChipsCents/100).toFixed(2)})));data.games[0]={...data.games[0],status:'completed',revision:data.games[0].revision+1,total_collected_cents:s.totals.totalMoneyCollectedCents,total_buy_ins:s.totals.totalBuyIns,total_final_chips_cents:s.totals.totalFinalChipsCents,variance_cents:s.totals.discrepancyCents};data.game_players=s.results.map(x=>({game_id:p.p_game,player_id:x.id,player_name_snapshot:x.name,buy_ins:x.buyIns,final_chips_cents:x.finalChipsCents,amount_paid_cents:x.amountPaidCents,raw_result_cents:x.rawResultCents,variance_adjustment_cents:x.adjustmentCents,final_result_cents:x.adjustedResultCents}));data.settlements=s.payments.map(x=>({game_id:p.p_game,from_player_id:x.fromId,to_player_id:x.toId,from_player_name_snapshot:x.fromName,to_player_name_snapshot:x.toName,amount_cents:x.amountCents}));return}
      if(name==='get_invite_code')return '0123456789ABCDEF0123456789ABCDEF';
      throw new Error('Unsupported mock RPC '+name)
    }
    ${actual.slice(actual.indexOf("export function inputsForGame"))}
  `;
  await page.route("**/src/lib/supabase.js*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: mock,
    }),
  );
  await page.reload();
  await page.getByRole("heading", { name: "Join your table" }).waitFor();
  await page.screenshot({
    path: `${output}/onboarding-375.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Create homegame", exact: true })
    .click();
  await page.getByRole("button", { name: "Players", exact: true }).click();
  for (const name of ["Akhil", "Ben", "Josh", "Ryan"]) {
    await page.getByLabel("New player", { exact: true }).fill(name);
    await page.getByRole("button", { name: "+ Add", exact: true }).click();
    await page
      .getByRole("button", { name: new RegExp(`${name} Profile`) })
      .waitFor();
  }
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.getByRole("button", { name: "+ New game", exact: true }).click();
  for (const name of ["Akhil", "Ben", "Josh", "Ryan"])
    await page.getByLabel(name, { exact: true }).check();
  await page.screenshot({ path: `${output}/new-game-375.png`, fullPage: true });
  await page.getByRole("button", { name: "Start game", exact: true }).click();
  const chips = ["50", "40", "20", "15"];
  for (const [i, name] of ["Akhil", "Ben", "Josh", "Ryan"].entries()) {
    await page
      .getByRole("button", {
        name: `Increase buy-ins for ${name}`,
        exact: true,
      })
      .click();
    await page
      .getByLabel(`Final chips for ${name}`, { exact: true })
      .fill(chips[i]);
    await page.getByRole("button", { name: "Save chips", exact: true }).click();
    await page
      .getByRole("button", { name: "Save chips", exact: true })
      .waitFor({ state: "hidden" });
  }
  await page
    .getByRole("button", { name: "Calculate settlement", exact: true })
    .click();
  await page.getByRole("heading", { name: "Results", exact: true }).waitFor();
  await page.screenshot({ path: `${output}/results-375.png`, fullPage: true });
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.screenshot({ path: `${output}/results-768.png`, fullPage: true });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
  );
  await page.setViewportSize({ width: 375, height: 812 });
  assert.ok(await page.getByText("-$3.33", { exact: true }).count());
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
  );
  await page
    .getByRole("button", { name: "Complete & save game", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "All-time leaderboard", exact: true })
    .waitFor();
  await page.screenshot({ path: `${output}/home-375.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: `${output}/home-1280.png`, fullPage: true });
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.getByRole("button", { name: /Sunday Poker/ }).click();
  await page.getByRole("button", { name: "Edit game", exact: true }).click();
  await page.getByLabel("Final chips for Akhil", { exact: true }).fill("45");
  await page
    .getByRole("button", { name: "Calculate settlement", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Save corrected game", exact: true })
    .click();
  await page.getByRole("button", { name: "Players", exact: true }).click();
  await page.getByRole("button", { name: /Akhil Profile/ }).click();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: `${output}/profile-375.png`, fullPage: true });
  await page
    .getByRole("button", { name: "Archive player", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Restore player", exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: setup, onboarding, player creation, new game, entries, settlement, completion, correction, profile, archive; no overflow at 375px; no browser errors. Database module mocked.",
  );
  console.log("Screenshots: " + output);
} finally {
  await browser.close();
}
