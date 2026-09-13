import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { calculateSettlement } from "../src/calculations.js";

// Real PostgreSQL policies/functions; only Supabase's auth.uid and auth.users are shimmed.
// This is not a hosted Auth or Realtime integration test.
test("schema, RLS boundaries, transactional games and revisions", async (t) => {
  const db = new PGlite();
  const users = [
    "10000000-0000-0000-0000-000000000001",
    "10000000-0000-0000-0000-000000000002",
    "10000000-0000-0000-0000-000000000003",
  ];
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth to authenticated,anon; grant execute on function auth.uid() to authenticated,anon;
      create publication supabase_realtime;`);
    for (const id of users)
      await db.query("insert into auth.users values($1)", [id]);
    await db.exec(
      await readFile(
        new URL("../supabase/schema.sql", import.meta.url),
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
    const rpc = async (name, args = []) => {
      const r = await db.query(
        `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) as value`,
        args,
      );
      return r.rows[0].value;
    };
    await asUser(users[0]);
    const a = await rpc("create_homegame", ["Table A"]),
      code = await rpc("get_invite_code", [a]);
    assert.equal(code.length, 32);
    await asUser(users[1]);
    const b = await rpc("create_homegame", ["Table B"]);
    await t.test(
      "nonmembers cannot read another homegame or its invite",
      async () => {
        assert.equal(
          (await db.query("select * from public.homegames where id=$1", [a]))
            .rows.length,
          0,
        );
        await assert.rejects(rpc("get_homegame_data", [a]), /Not a member/);
        await assert.rejects(rpc("get_invite_code", [a]), /Not a member/);
        await assert.rejects(
          db.query("select * from private.invites"),
          /permission denied/,
        );
        await assert.rejects(
          db.query(
            "insert into public.homegame_members(homegame_id,user_id) values($1,$2)",
            [a, users[1]],
          ),
          /permission denied/,
        );
        await assert.rejects(
          db.query("update public.homegame_members set homegame_id=$1", [a]),
          /permission denied/,
        );
        await assert.rejects(
          rpc("save_player", [a, "Intruder"]),
          /Not a member/,
        );
      },
    );
    await asUser(users[2]);
    await t.test(
      "join code validation and duplicate membership prevention",
      async () => {
        await assert.rejects(
          rpc("join_homegame_by_code", ["invalid"]),
          /Invite code not found/,
        );
        assert.equal(
          await rpc("join_homegame_by_code", [code.toLowerCase()]),
          a,
        );
        assert.equal(await rpc("join_homegame_by_code", [code]), a);
        assert.equal(
          (await db.query("select * from public.homegame_members")).rows.length,
          1,
        );
      },
    );
    const ids = [];
    for (const name of ["Akhil", "Ben", "Josh", "Ryan"])
      ids.push(await rpc("save_player", [a, name]));
    await assert.rejects(
      rpc("save_player", [a, "  AKHIL  "]),
      /unique constraint/,
    );
    await t.test("null player arrays cannot create empty games", async () => {
      await assert.rejects(
        rpc("start_game", [a, "Invalid", "2026-09-13", null]),
        /Choose 2 to 22/,
      );
    });
    const game = await rpc("start_game", [
      a,
      "Sunday Poker",
      "2026-09-13",
      ids,
    ]);
    await t.test(
      "one active game, own-group keys and protected direct writes",
      async () => {
        await assert.rejects(
          rpc("start_game", [a, "Duplicate", "2026-09-13", ids]),
          /unique constraint/,
        );
        await assert.rejects(
          db.query("update public.games set homegame_id=$1 where id=$2", [
            b,
            game,
          ]),
          /permission denied/,
        );
        await assert.rejects(
          db.query(
            "update public.game_players set buy_ins=20 where game_id=$1",
            [game],
          ),
          /permission denied/,
        );
        await asUser(users[1]);
        await assert.rejects(
          rpc("start_game", [b, "Foreign players", "2026-09-13", ids]),
          /Invalid or archived/,
        );
        await assert.rejects(
          rpc("update_game_input", [game, ids[0], 1]),
          /Not a member/,
        );
        await assert.rejects(rpc("delete_game", [game, 0]), /Not a member/);
        for (const table of ["games", "players", "game_players", "settlements"])
          assert.equal(
            (
              await db.query(
                `select * from public.${table} where homegame_id=$1`,
                [a],
              )
            ).rows.length,
            0,
          );
        await asUser(users[0]);
      },
    );
    await t.test(
      "atomic buy-in increments and conflicting chip edits",
      async () => {
        await rpc("update_game_input", [game, ids[0], 1]);
        await asUser(users[2]);
        await rpc("update_game_input", [game, ids[0], 1]);
        assert.equal(
          (
            await db.query(
              "select buy_ins from public.game_players where game_id=$1 and player_id=$2",
              [game, ids[0]],
            )
          ).rows[0].buy_ins,
          3,
        );
        await rpc("update_game_input", [game, ids[0], null, 5000, 0]);
        await assert.rejects(
          rpc("update_game_input", [game, ids[0], null, 6000, 0]),
          /changed on another device/,
        );
      },
    );
    const input = ids.map((id, i) => ({
      id,
      name: ["Akhil", "Ben", "Josh", "Ryan"][i],
      buyIns: 2,
      finalChips: ["50", "40", "20", "15"][i],
    }));
    const calculation = calculateSettlement(input);
    const financialInputs = calculation.results.map((p) => ({
      id: p.id,
      buyIns: p.buyIns,
      finalChipsCents: p.finalChipsCents,
    }));
    const revision = async () =>
      Number(
        (
          await db.query("select revision from public.games where id=$1", [
            game,
          ])
        ).rows[0].revision,
      );
    const complete = async (
      rev,
      payments = calculation.payments,
      entries = financialInputs,
    ) =>
      rpc("complete_game", [
        game,
        rev,
        "Sunday Poker",
        "2026-09-13",
        JSON.stringify(entries),
        JSON.stringify(payments),
      ]);
    await t.test(
      "stale completion rejected and invalid transfers roll back all writes",
      async () => {
        await assert.rejects(complete(0), /changed on another device/);
        const before = await rpc("get_homegame_data", [a]);
        await assert.rejects(
          complete(await revision(), [
            { fromId: ids[0], toId: ids[1], amountCents: 100 },
          ]),
          /debtor to creditor/,
        );
        assert.deepEqual(await rpc("get_homegame_data", [a]), before);
        await assert.rejects(complete(await revision(), []), /do not settle/);
        assert.deepEqual(await rpc("get_homegame_data", [a]), before);
      },
    );
    await t.test(
      "null revisions and malformed completion inputs are rejected",
      async () => {
        await assert.rejects(complete(null), /changed on another device/);
        await assert.rejects(rpc("delete_game", [game, null]), /changed/);
        await assert.rejects(
          rpc("complete_game", [
            game,
            await revision(),
            "Invalid",
            "2026-09-13",
            null,
            "[]",
          ]),
          /must be arrays/,
        );
        await assert.rejects(
          rpc("complete_game", [
            game,
            await revision(),
            "Invalid",
            "2026-09-13",
            "{}",
            "[]",
          ]),
          /must be arrays/,
        );
      },
    );
    await complete(await revision());
    await t.test(
      "completion persists server-computed outputs and snapshots",
      async () => {
        const snapshot = await rpc("get_homegame_data", [a]);
        assert.equal(snapshot.games[0].status, "completed");
        assert.equal(snapshot.games[0].variance_cents, 500);
        for (const p of calculation.results) {
          const saved = snapshot.game_players.find((x) => x.player_id === p.id);
          assert.equal(saved.final_result_cents, p.adjustedResultCents);
          assert.equal(saved.variance_adjustment_cents, p.adjustmentCents);
        }
        await assert.rejects(
          rpc("update_game_input", [game, ids[0], 1]),
          /already completed/,
        );
        await rpc("save_player", [a, "Akhil renamed", ids[0], true]);
        const history = await rpc("get_homegame_data", [a]);
        assert.equal(
          history.game_players.find((p) => p.player_id === ids[0])
            .player_name_snapshot,
          "Akhil",
        );
        await assert.rejects(
          rpc("start_game", [a, "Archived", "2026-09-13", ids]),
          /Invalid or archived/,
        );
      },
    );
    await t.test(
      "correction replaces settlements and agrees on one-cent variance ties",
      async () => {
        const corrected = calculateSettlement(
          input.map((p, i) => ({
            ...p,
            finalChips: ["30.01", "30.01", "29.99", "30"][i],
          })),
        );
        await complete(
          await revision(),
          corrected.payments,
          corrected.results.map((p) => ({
            id: p.id,
            buyIns: p.buyIns,
            finalChipsCents: p.finalChipsCents,
          })),
        );
        const snapshot = await rpc("get_homegame_data", [a]);
        assert.equal(snapshot.settlements.length, corrected.payments.length);
        for (const p of corrected.results)
          assert.equal(
            snapshot.game_players.find((x) => x.player_id === p.id)
              .final_result_cents,
            p.adjustedResultCents,
          );
      },
    );
    await t.test(
      "negative variance also matches server calculations",
      async () => {
        const corrected = calculateSettlement(
          input.map((p, i) => ({
            ...p,
            finalChips: ["50", "40", "20", "5"][i],
          })),
        );
        await complete(
          await revision(),
          corrected.payments,
          corrected.results.map((p) => ({
            id: p.id,
            buyIns: p.buyIns,
            finalChipsCents: p.finalChipsCents,
          })),
        );
        const snapshot = await rpc("get_homegame_data", [a]);
        assert.equal(snapshot.games[0].variance_cents, -500);
        for (const p of corrected.results)
          assert.equal(
            snapshot.game_players.find((x) => x.player_id === p.id)
              .final_result_cents,
            p.adjustedResultCents,
          );
      },
    );
    await t.test(
      "deletion cascades and signed-out role has no app access",
      async () => {
        await rpc("delete_game", [game, await revision()]);
        const snapshot = await rpc("get_homegame_data", [a]);
        assert.equal(snapshot.games.length, 0);
        assert.equal(snapshot.game_players.length, 0);
        assert.equal(snapshot.settlements.length, 0);
        await db.exec("reset role; set role anon");
        await assert.rejects(
          rpc("create_homegame", ["No auth"]),
          /permission denied/,
        );
        await assert.rejects(
          db.query("select * from public.homegames"),
          /permission denied/,
        );
      },
    );
  } finally {
    await db.close();
  }
});
