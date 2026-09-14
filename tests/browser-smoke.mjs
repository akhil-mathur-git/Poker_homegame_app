// Optional UI smoke test. Uses an intercepted database module, NOT hosted Supabase.
// PLAYWRIGHT_MODULE_PATH may point at an existing Playwright installation.
import { readFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
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
const db = new PGlite();
const ownerId = "10000000-0000-0000-0000-000000000001",
  otherId = "10000000-0000-0000-0000-000000000002";
await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;create publication supabase_realtime;`);
await db.query("insert into auth.users values($1),($2)", [ownerId, otherId]);
await db.exec(
  await readFile(new URL("../supabase/schema.sql", import.meta.url), "utf8"),
);
await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
  otherId,
]);
const groupC = (
  await db.query("select public.create_homegame('Table C') as id")
).rows[0].id;
await db.query(
  "update private.invites set code='TESTCINVITE' where homegame_id=$1",
  [groupC],
);
await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
  ownerId,
]);
await db.exec("set role authenticated");
await page.exposeFunction("__dbRpc", async (name, args = {}) => {
  if (name === "list")
    return (
      await db.query(
        "select id,name,created_at,created_by from public.homegames order by created_at,id",
      )
    ).rows;
  const keys = Object.keys(args);
  if (!/^[a-z_]+$/.test(name) || keys.some((k) => !/^p_[a-z_]+$/.test(k)))
    throw new Error("Invalid fixture call");
  const result = await db.query(
    `select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(",")}) as value`,
    keys.map((k) =>
      ["p_inputs", "p_payments"].includes(k)
        ? JSON.stringify(args[k])
        : args[k],
    ),
  );
  return result.rows[0].value;
});
try {
  const actual = await readFile(
    new URL("../src/lib/supabase.js", import.meta.url),
    "utf8",
  );
  // Intercept before navigation, even when the developer has real .env credentials.
  // This test must never connect to or modify their Supabase project.
  await page.route("**/src/lib/supabase.js*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: `
    export const supabase=null,configurationError='';
    export async function ensureSession(){} export async function loadHomegames(){} export async function loadData(){} export async function rpc(){}
    ${actual.slice(actual.indexOf("export function inputsForGame"))}
  `,
    }),
  );
  await page.goto(base);
  await page.getByRole("heading", { name: "Connect your homegame" }).waitFor();
  await page.screenshot({ path: `${output}/setup-375.png`, fullPage: true });
  await page.unroute("**/src/lib/supabase.js*");
  const mock = `
    export const configurationError='';
    window.__channels=[];window.__fetches=[];
    export const supabase={channel:name=>({name,active:false,callbacks:[],on(kind,filter,callback){this.callbacks.push({filter,callback});return this},subscribe(cb){this.active=true;window.__channels.push(this);cb('SUBSCRIBED');return this}}),removeChannel(channel){channel.active=false}};
    export async function ensureSession(){return {user:{id:'${ownerId}'}}}
    export async function loadHomegames(){return window.__dbRpc('list')}
    export async function loadData(id){window.__fetches.push(id);const result=await window.__dbRpc('get_homegame_data',{p_homegame:id});if(window.__delayGroup===id)await new Promise(resolve=>setTimeout(resolve,700));return result;}
    export async function rpc(name,p){return window.__dbRpc(name,p)}
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
    await page.getByRole("button", { name: "Save entry", exact: true }).click();
    await page
      .getByRole("button", { name: "Save entry", exact: true })
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
  const groupA = await page
    .getByLabel("Selected homegame", { exact: true })
    .inputValue();
  await page
    .getByLabel("Selected homegame", { exact: true })
    .selectOption("create");
  await page.getByLabel("Homegame name", { exact: true }).fill("Table B");
  await page
    .getByRole("button", { name: "Create homegame", exact: true })
    .click();
  const switcher = page.getByLabel("Selected homegame", { exact: true });
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  const groupB = await switcher.inputValue();
  assert.notEqual(groupA, groupB);
  assert.equal(await page.getByText("Akhil", { exact: true }).count(), 0);
  await page
    .getByRole("button", { name: "Settings and invite", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Show & copy invite code", exact: true })
    .click();
  const inviteB = await page.locator(".invite-code").innerText();
  const downloadBPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export backup", exact: true })
    .click();
  const downloadB = await downloadBPromise;
  const backupB = JSON.parse(await readFile(await downloadB.path(), "utf8"));
  assert.equal(backupB.homegame.id, groupB);
  assert.deepEqual(backupB.games, []);
  await switcher.selectOption(groupA);
  await page
    .getByRole("button", { name: "Settings and invite", exact: true })
    .click();
  assert.equal(await page.getByText(inviteB, { exact: true }).count(), 0);
  await page
    .getByRole("button", { name: "Show & copy invite code", exact: true })
    .click();
  const inviteA = await page.locator(".invite-code").innerText();
  assert.notEqual(inviteA, inviteB);
  const downloadAPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export backup", exact: true })
    .click();
  const downloadA = await downloadAPromise;
  const backupA = JSON.parse(await readFile(await downloadA.path(), "utf8"));
  assert.equal(backupA.homegame.id, groupA);
  assert.equal(backupA.games.length, 1);
  await switcher.selectOption(groupB);

  await page.getByRole("button", { name: "Players", exact: true }).click();
  for (const name of ["B-only player", "B second player"]) {
    await page.getByLabel("New player", { exact: true }).fill(name);
    await page.getByRole("button", { name: "+ Add", exact: true }).click();
    await page
      .getByRole("button", { name: new RegExp(name + " Profile") })
      .waitFor();
  }
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.getByRole("button", { name: "+ New game", exact: true }).click();
  for (const name of ["B-only player", "B second player"])
    await page.getByLabel(name, { exact: true }).check();
  await page.getByLabel("Game name", { exact: true }).fill("B active");
  await page.getByLabel("Flexible amount", { exact: true }).check();
  await page.getByRole("button", { name: "Start game", exact: true }).click();
  await page.getByRole("heading", { name: "B active", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: /Increase buy-ins/ }).count(),
    0,
  );
  await page
    .getByRole("button", { name: "Calculate settlement", exact: true })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Enter a result for every player" })
    .waitFor();
  for (const [name, amount, field, result] of [
    ["B-only player", "47.50", "Final chips", "70.50"],
    ["B second player", "30.00", "Net P/L", "-23.00"],
  ]) {
    await page
      .getByLabel(`Amount in for ${name}`, { exact: true })
      .fill(amount);
    await page.getByLabel(`${field} for ${name}`, { exact: true }).fill(result);
    await page.getByRole("button", { name: "Save entry", exact: true }).click();
    await page
      .getByRole("button", { name: "Save entry", exact: true })
      .waitFor({ state: "hidden" });
  }
  assert.equal(
    await page
      .getByLabel("Final chips for B second player", { exact: true })
      .inputValue(),
    "7.00",
  );
  await page.screenshot({
    path: `${output}/flexible-entry-375.png`,
    fullPage: true,
  });

  await switcher.selectOption(groupA);
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  assert.equal(await page.getByText("B active", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.getByRole("button", { name: /Sunday Poker/ }).waitFor();
  await page.getByRole("button", { name: "Players", exact: true }).click();
  assert.equal(
    await page.getByRole("button", { name: /B-only player/ }).count(),
    0,
  );
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.getByRole("button", { name: "+ New game", exact: true }).click();
  for (const name of ["Ben", "Josh"])
    await page.getByLabel(name, { exact: true }).check();
  await page.getByLabel("Game name", { exact: true }).fill("A active");
  await page.getByLabel("Buy-in value", { exact: true }).fill("20.00");
  await page.getByRole("button", { name: "Start game", exact: true }).click();
  await page.getByRole("heading", { name: "A active", exact: true }).waitFor();
  await page.getByLabel("Net P/L for Ben", { exact: true }).fill("+23");
  assert.equal(
    await page.getByLabel("Final chips for Ben", { exact: true }).inputValue(),
    "43.00",
  );
  await page.getByRole("button", { name: "Save entry", exact: true }).click();
  await page
    .getByRole("button", { name: "Save entry", exact: true })
    .waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: "Increase buy-ins for Ben", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Final chips for Ben"]').value ===
      "63.00",
  );
  await page.getByLabel("Final chips for Ben", { exact: true }).fill("68.00");
  await page.getByRole("button", { name: "Save entry", exact: true }).click();
  await page
    .getByRole("button", { name: "Save entry", exact: true })
    .waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: "Increase buy-ins for Ben", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Net P/L for Ben"]').value === "8.00",
  );
  await page.screenshot({
    path: `${output}/fixed-linked-375.png`,
    fullPage: true,
  });

  // Trigger a delayed A snapshot via Realtime, then switch before it resolves.
  await page.evaluate((id) => {
    window.__delayGroup = id;
    window.__channels.find((c) => c.active).callbacks[0].callback();
  }, groupA);
  await page.waitForFunction((id) => window.__fetches.at(-1) === id, groupA);
  await page.waitForTimeout(160);
  await switcher.selectOption(groupB);
  await page.getByRole("heading", { name: "B active", exact: true }).waitFor();
  await page.waitForTimeout(850);
  assert.equal(await page.getByText("A active", { exact: true }).count(), 0);
  assert.equal(
    await page.evaluate(() => window.__channels.filter((c) => c.active).length),
    1,
  );
  assert.ok(
    (
      await page.evaluate(() => window.__channels.find((c) => c.active).name)
    ).startsWith("homegame-" + groupB + "-"),
  );
  assert.equal(
    await page.evaluate(
      () => new Set(window.__channels.map((c) => c.name)).size,
    ),
    await page.evaluate(() => window.__channels.length),
  );
  const fetchCount = await page.evaluate(() => window.__fetches.length);
  await page.evaluate(() => {
    for (const c of window.__channels.filter((c) => !c.active))
      for (const entry of c.callbacks) entry.callback();
  });
  await page.waitForTimeout(180);
  assert.equal(await page.evaluate(() => window.__fetches.length), fetchCount);
  await page.screenshot({
    path: `${output}/multiple-tables-375.png`,
    fullPage: true,
  });
  await page.reload();
  await page.getByRole("heading", { name: "B active", exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Selected homegame", { exact: true }).inputValue(),
    groupB,
  );
  await page.evaluate(() =>
    localStorage.setItem("poker-selected-homegame-id", "not-a-membership"),
  );
  await page.reload();
  await page.getByRole("heading", { name: "A active", exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Selected homegame", { exact: true }).inputValue(),
    groupA,
  );
  await page
    .getByLabel("Selected homegame", { exact: true })
    .selectOption("join");
  await page.getByLabel("Invite code", { exact: true }).fill("TEST-C-INVITE");
  await page
    .getByRole("button", { name: "Join homegame", exact: true })
    .click();
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  assert.equal(
    await page
      .getByLabel("Selected homegame", { exact: true })
      .locator("option")
      .count(),
    6,
  );
  assert.equal(await page.getByText("A active", { exact: true }).count(), 0);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );

  await page
    .getByRole("button", { name: "Settings and invite", exact: true })
    .click();
  assert.equal(
    await page
      .getByRole("button", { name: "Delete homegame", exact: true })
      .count(),
    0,
  );
  await page
    .getByRole("button", { name: "Leave homegame", exact: true })
    .click();
  await page.getByRole("dialog").waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Leave homegame", exact: true })
    .click();
  await page.getByRole("button", { name: "Yes, leave", exact: true }).click();
  await page.getByRole("heading", { name: "A active", exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Settings and invite", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Delete homegame", exact: true })
    .click();
  await page.screenshot({
    path: `${output}/delete-confirmation-375.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Yes, delete permanently", exact: true })
    .click();
  await page.getByRole("heading", { name: "B active", exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Selected homegame", { exact: true }).inputValue(),
    groupB,
  );
  await page
    .getByRole("button", { name: "Continue game →", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Calculate settlement", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Complete & save game", exact: true })
    .click();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.getByRole("button", { name: /B active/ }).click();
  await page.getByRole("button", { name: "Edit game", exact: true }).click();
  await page
    .getByLabel("Amount in for B second player", { exact: true })
    .fill("40.00");
  assert.equal(
    await page
      .getByLabel("Net P/L for B second player", { exact: true })
      .inputValue(),
    "-23.00",
  );
  assert.equal(
    await page
      .getByLabel("Final chips for B second player", { exact: true })
      .inputValue(),
    "17.00",
  );
  await page
    .getByRole("button", { name: "Calculate settlement", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Save corrected game", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Settings and invite", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Delete homegame", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Yes, delete permanently", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Join your table", exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(() =>
      localStorage.getItem("poker-selected-homegame-id"),
    ),
    null,
  );
  assert.equal(
    await page.evaluate(() => window.__channels.filter((c) => c.active).length),
    0,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: setup, onboarding, player creation, new game, entries, settlement, completion, correction, profile, archive; no overflow at 375px; no browser errors. Multi-table isolation, reload preference, invite joining, delayed snapshots and subscription cleanup passed. Database calls exercised in isolated PostgreSQL; Auth and Realtime transport mocked.",
  );
  console.log("Screenshots: " + output);
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png`, fullPage: true });
  console.error(await page.locator("body").innerText());
  throw error;
} finally {
  await browser.close();
  await db.close();
}
