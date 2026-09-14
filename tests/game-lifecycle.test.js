import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { calculateSettlement } from "../src/calculations.js";
const migrationUrl = new URL(
  "../supabase/migrations/20260915_flexible_buyins_results_and_lifecycle.sql",
  import.meta.url,
);
test("populated V2 migration, game inputs, security and lifecycle", async (t) => {
  const db = new PGlite();
  const users = [
    "10000000-0000-0000-0000-000000000001",
    "10000000-0000-0000-0000-000000000002",
    "10000000-0000-0000-0000-000000000003",
  ];
  try {
    await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
  grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;create publication supabase_realtime;`);
    for (const user of users)
      await db.query("insert into auth.users values($1)", [user]);
    await db.exec(
      await readFile(
        new URL("fixtures/schema-v2.sql", import.meta.url),
        "utf8",
      ),
    );
    const asUser = async (user) => {
      await db.exec("reset role");
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
        user,
      ]);
      await db.exec("set role authenticated");
    };
    const rpc = async (name, args = []) =>
      (
        await db.query(
          `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) as value`,
          args,
        )
      ).rows[0].value;
    await asUser(users[0]);
    const a = await rpc("create_homegame", ["A"]),
      b = await rpc("create_homegame", ["B"]);
    const ids = [];
    for (const name of ["Akhil", "Josh"])
      ids.push(await rpc("save_player", [a, name]));
    const historic = await rpc("start_game", [
      a,
      "Old $15 game",
      "2026-09-13",
      ids,
    ]);
    const original = calculateSettlement(
      ids.map((id, i) => ({
        id,
        name: `P${i}`,
        buyIns: 1,
        finalChips: i ? "0" : "30",
      })),
    );
    await rpc("complete_game", [
      historic,
      0,
      "Old $15 game",
      "2026-09-13",
      JSON.stringify(
        original.results.map((p) => ({
          id: p.id,
          buyIns: p.buyIns,
          finalChipsCents: p.finalChipsCents,
        })),
      ),
      JSON.stringify(original.payments),
    ]);
    const active = await rpc("start_game", [
      a,
      "Old active",
      "2026-09-15",
      ids,
    ]);
    const before = await rpc("get_homegame_data", [a]);
    const members = (
      await db.query(
        "select * from public.homegame_members order by homegame_id",
      )
    ).rows;
    const code = await rpc("get_invite_code", [a]);
    await t.test(
      "migration preserves old inputs, financial snapshots, memberships and invites",
      async () => {
        await db.exec("reset role");
        await db.exec(await readFile(migrationUrl, "utf8"));
        await asUser(users[0]);
        const after = await rpc("get_homegame_data", [a]);
        for (const table of Object.keys(before))
          for (const row of before[table]) {
            const saved = after[table].find((p) => p.id === row.id);
            for (const key of Object.keys(row))
              assert.deepEqual(saved[key], row[key], `${table}.${key}`);
          }
        assert.ok(
          after.games.every(
            (g) => g.buy_in_mode === "fixed" && g.buy_in_value_cents === 1500,
          ),
        );
        assert.ok(
          after.game_players.every(
            (p) =>
              p.result_entry_mode === "final_chips" &&
              p.result_entry_cents === p.final_chips_cents,
          ),
        );
        assert.deepEqual(
          (
            await db.query(
              "select * from public.homegame_members order by homegame_id",
            )
          ).rows,
          members,
        );
        assert.equal(await rpc("get_invite_code", [a]), code);
      },
    );
    const row = async (game, id) =>
      (
        await db.query(
          "select * from public.game_players where game_id=$1 and player_id=$2",
          [game, id],
        )
      ).rows[0];
    const save = async (
      game,
      id,
      amount,
      mode,
      cents,
      entered = true,
      revision = null,
    ) =>
      rpc("save_game_entry", [
        game,
        id,
        revision ?? (await row(game, id)).input_revision,
        amount,
        mode,
        cents,
        entered,
      ]);
    await t.test(
      "fixed increments derive from source; switching source is atomic",
      async () => {
        await rpc("update_game_input", [active, ids[0], 1]);
        await rpc("update_game_input", [active, ids[0], 1]);
        await save(active, ids[0], null, "net_pl", 2300);
        assert.equal((await row(active, ids[0])).final_chips_cents, 6800);
        await rpc("update_game_input", [active, ids[0], 1]);
        assert.equal((await row(active, ids[0])).final_chips_cents, 8300);
        assert.equal((await row(active, ids[0])).result_entry_cents, 2300);
        await save(active, ids[0], null, "final_chips", 6800);
        await rpc("update_game_input", [active, ids[0], 1]);
        assert.equal((await row(active, ids[0])).final_chips_cents, 6800);
        assert.equal((await row(active, ids[0])).amount_in_cents, 7500);
        const before = await row(active, ids[1]);
        await assert.rejects(
          save(active, ids[1], null, "net_pl", -2000),
          /negative final chips/,
        );
        assert.deepEqual(await row(active, ids[1]), before);
      },
    );
    // Finish legacy active then start flexible in the same homegame, retaining history.
    await rpc("delete_game", [
      active,
      (
        await db.query("select revision from public.games where id=$1", [
          active,
        ])
      ).rows[0].revision,
    ]);
    const flex = await rpc("start_game", [
      a,
      "Flexible",
      "2026-09-15",
      ids,
      "flexible",
      null,
    ]);
    await t.test(
      "flexible inputs have no count, blank is not zero, conflicts do not overwrite",
      async () => {
        assert.equal((await row(flex, ids[0])).buy_ins, null);
        assert.equal((await row(flex, ids[0])).result_entry_cents, null);
        assert.equal((await row(flex, ids[0])).final_chips_cents, null);
        await save(flex, ids[0], 4750, null, null, false);
        await save(flex, ids[0], null, "net_pl", 2300);
        assert.equal((await row(flex, ids[0])).final_chips_cents, 7050);
        const revision = (await row(flex, ids[0])).input_revision;
        await save(flex, ids[0], 6000, null, null, false);
        assert.equal((await row(flex, ids[0])).final_chips_cents, 8300);
        await assert.rejects(
          save(flex, ids[0], 7000, null, null, false, revision),
          /changed on another device/,
        );
        await save(flex, ids[0], null, "final_chips", 6800);
        await save(flex, ids[0], 4500, null, null, false);
        assert.equal((await row(flex, ids[0])).final_chips_cents, 6800);
        await assert.rejects(
          rpc("update_game_input", [flex, ids[0], 1]),
          /Invalid buy-in change/,
        );
        await save(flex, ids[1], 3000, null, null, false);
        const revisionGame = (
          await db.query("select revision from public.games where id=$1", [
            flex,
          ])
        ).rows[0].revision;
        await assert.rejects(
          rpc("complete_game", [
            flex,
            revisionGame,
            "Flexible",
            "2026-09-15",
            JSON.stringify(
              ids.map((id) => ({
                id,
                buyIns: null,
                amountInCents: 3000,
                resultEntryMode: "final_chips",
                resultEntryCents: null,
              })),
            ),
            "[]",
          ]),
          /Enter a result for every player/,
        );
      },
    );
    await t.test(
      "completion and correction preserve new input source and financial validity",
      async () => {
        const inputs = [
          {
            id: ids[0],
            name: "A",
            amountIn: "45",
            resultEntryMode: "final_chips",
            resultEntry: "68",
          },
          {
            id: ids[1],
            name: "B",
            amountIn: "30",
            resultEntryMode: "net_pl",
            resultEntry: "-20",
          },
        ];
        const calc = calculateSettlement(inputs, { buy_in_mode: "flexible" });
        const revision = (
          await db.query("select revision from public.games where id=$1", [
            flex,
          ])
        ).rows[0].revision;
        await rpc("complete_game", [
          flex,
          revision,
          "Flexible",
          "2026-09-15",
          JSON.stringify(calc.results),
          JSON.stringify(calc.payments),
        ]);
        const snapshot = await rpc("get_homegame_data", [a]);
        assert.equal(
          snapshot.games.find((g) => g.id === flex).total_buy_ins,
          null,
        );
        for (const result of calc.results) {
          const saved = await row(flex, result.id);
          assert.equal(saved.final_result_cents, result.adjustedResultCents);
          assert.equal(saved.result_entry_cents, result.resultEntryCents);
        }
        // Correct amount in without changing the net source.
        inputs[1].amountIn = "40";
        const corrected = calculateSettlement(inputs, {
          buy_in_mode: "flexible",
        });
        await rpc("complete_game", [
          flex,
          revision + 1,
          "Corrected flexible",
          "2026-09-15",
          JSON.stringify(corrected.results),
          JSON.stringify(corrected.payments),
        ]);
        assert.equal((await row(flex, ids[1])).final_chips_cents, 2000);
        const fixed = await rpc("start_game", [
          a,
          "Fixed $20",
          "2026-09-15",
          ids,
          "fixed",
          2000,
        ]);
        await rpc("update_game_input", [fixed, ids[0], 1]);
        await rpc("update_game_input", [fixed, ids[0], 1]);
        assert.equal((await row(fixed, ids[0])).amount_in_cents, 6000);
        assert.equal(
          (
            await db.query(
              "select buy_in_value_cents from public.games where id=$1",
              [historic],
            )
          ).rows[0].buy_in_value_cents,
          1500,
        );
      },
    );
    await t.test(
      "migration rerun leaves new blank inputs and all snapshots unchanged",
      async () => {
        const before = await rpc("get_homegame_data", [a]);
        await db.exec("reset role");
        await db.exec(await readFile(migrationUrl, "utf8"));
        await asUser(users[0]);
        assert.deepEqual(await rpc("get_homegame_data", [a]), before);
      },
    );
    await t.test(
      "non-owner can leave and rejoin without removing any homegame data",
      async () => {
        const snapshot = await rpc("get_homegame_data", [a]);
        await asUser(users[1]);
        await rpc("join_homegame_by_code", [code]);
        await assert.rejects(rpc("delete_homegame", [a]), /Only the owner/);
        await assert.rejects(
          db.query("delete from public.homegame_members where homegame_id=$1", [
            a,
          ]),
          /permission denied/,
        );
        await rpc("leave_homegame", [a]);
        await assert.rejects(rpc("get_homegame_data", [a]), /Not a member/);
        await assert.rejects(rpc("leave_homegame", [a]), /Not a member/);
        await rpc("join_homegame_by_code", [code]);
        assert.deepEqual(await rpc("get_homegame_data", [a]), snapshot);
      },
    );
    await t.test(
      "owner and unrelated-user security checks cannot be spoofed",
      async () => {
        await asUser(users[0]);
        await assert.rejects(
          rpc("leave_homegame", [a]),
          /You created this homegame/,
        );
        await asUser(users[2]);
        await assert.rejects(rpc("leave_homegame", [a]), /Not a member/);
        await assert.rejects(rpc("delete_homegame", [a]), /Only the owner/);
        await assert.rejects(
          rpc("save_game_entry", [flex, ids[0], 0, 10, "net_pl", 0, true]),
          /Not a member/,
        );
        await assert.rejects(
          rpc("start_game", [
            a,
            "Intrusion",
            "2026-09-15",
            ids,
            "flexible",
            null,
          ]),
          /Not a member/,
        );
      },
    );
    await t.test(
      "owner deletion cascades only target data and invalidates the invite",
      async () => {
        await asUser(users[0]);
        const other = await rpc("get_homegame_data", [b]);
        await rpc("delete_homegame", [a]);
        assert.deepEqual(await rpc("get_homegame_data", [b]), other);
        assert.equal(
          (await db.query("select * from public.homegame_members")).rows.length,
          1,
        );
        await assert.rejects(
          rpc("join_homegame_by_code", [code]),
          /Invite code not found/,
        );
        await db.exec("reset role");
        for (const table of [
          "homegames",
          "homegame_members",
          "players",
          "games",
          "game_players",
          "settlements",
        ])
          assert.equal(
            (
              await db.query(
                `select count(*)::int as n from public.${table} where ${table === "homegames" ? "id" : "homegame_id"}=$1`,
                [a],
              )
            ).rows[0].n,
            0,
          );
        assert.equal(
          (
            await db.query(
              "select count(*)::int as n from private.invites where homegame_id=$1",
              [a],
            )
          ).rows[0].n,
          0,
        );
        await db.exec("set role anon");
        await assert.rejects(rpc("delete_homegame", [b]), /permission denied/);
        await assert.rejects(rpc("leave_homegame", [b]), /permission denied/);
      },
    );
  } finally {
    await db.close();
  }
});
