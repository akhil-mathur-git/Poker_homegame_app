import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { calculateSettlement } from "../src/calculations.js";
import { playerStatistics } from "../src/lib/statistics.js";
import { buildBackup } from "../src/lib/backup.js";

for (const upgrade of [false, true])
  test(`multiple memberships ${upgrade ? "after preserving a populated legacy database" : "on a fresh installation"}`, async (t) => {
    const db = new PGlite();
    const users = [
      "10000000-0000-0000-0000-000000000001",
      "10000000-0000-0000-0000-000000000002",
      "10000000-0000-0000-0000-000000000003",
    ];
    try {
      await db.exec(`create role anon;create role authenticated;create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;
      create publication supabase_realtime;`);
      for (const user of users)
        await db.query("insert into auth.users values($1)", [user]);
      let schema = await readFile(
        new URL("../supabase/schema.sql", import.meta.url),
        "utf8",
      );
      if (upgrade)
        schema = schema
          .replace(
            "primary key(homegame_id,user_id)",
            "primary key(homegame_id,user_id), unique(user_id)",
          )
          .replace(
            "create index homegame_members_user_id_idx on public.homegame_members(user_id);",
            "",
          );
      await db.exec(schema);
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
      const list = async () =>
        (
          await db.query(
            "select id,name,created_at from public.homegames order by created_at,id",
          )
        ).rows;
      await asUser(users[0]);
      const a = await rpc("create_homegame", ["Table A"]);
      const pa = [];
      for (const name of ["Akhil", "Josh"])
        pa.push(await rpc("save_player", [a, name]));
      const oldGame = await rpc("start_game", [
        a,
        "Original history",
        "2026-09-13",
        pa,
      ]);
      const settlement = calculateSettlement(
        pa.map((id, i) => ({
          id,
          name: ["Akhil", "Josh"][i],
          buyIns: 1,
          finalChips: i ? "0" : "30",
        })),
      );
      await rpc("complete_game", [
        oldGame,
        0,
        "Original history",
        "2026-09-13",
        JSON.stringify(
          settlement.results.map((p) => ({
            id: p.id,
            buyIns: p.buyIns,
            finalChipsCents: p.finalChipsCents,
          })),
        ),
        JSON.stringify(settlement.payments),
      ]);
      if (upgrade)
        await t.test(
          "migration preserves every existing row and can be rerun",
          async () => {
            await assert.rejects(
              rpc("create_homegame", ["Blocked before migration"]),
              /homegame_members_user_id_key/,
            );
            const before = await rpc("get_homegame_data", [a]),
              groups = await list(),
              members = (
                await db.query("select * from public.homegame_members")
              ).rows,
              invite = await rpc("get_invite_code", [a]);
            await db.exec("reset role");
            const migration = await readFile(
              new URL(
                "../supabase/migrations/20260914_multiple_homegames.sql",
                import.meta.url,
              ),
              "utf8",
            );
            await db.exec(migration);
            await db.exec(migration);
            await asUser(users[0]);
            assert.deepEqual(await rpc("get_homegame_data", [a]), before);
            assert.deepEqual(await list(), groups);
            assert.deepEqual(
              (await db.query("select * from public.homegame_members")).rows,
              members,
            );
            assert.equal(await rpc("get_invite_code", [a]), invite);
          },
        );
      const b = await rpc("create_homegame", ["Table B"]);
      assert.deepEqual(
        new Set((await list()).map((g) => g.id)),
        new Set([a, b]),
      );
      const pb = [];
      for (const name of ["Akhil", "Ben"])
        pb.push(await rpc("save_player", [b, name]));
      const activeA = await rpc("start_game", [
        a,
        "A active",
        "2026-09-14",
        pa,
      ]);
      const activeB = await rpc("start_game", [
        b,
        "B active",
        "2026-09-14",
        pb,
      ]);
      await t.test(
        "independent active games, players, history, statistics and backups",
        async () => {
          const da = await rpc("get_homegame_data", [a]),
            dbData = await rpc("get_homegame_data", [b]);
          assert.equal(da.games.find((g) => g.status === "active").id, activeA);
          assert.equal(
            dbData.games.find((g) => g.status === "active").id,
            activeB,
          );
          assert.ok(da.players.every((p) => p.homegame_id === a));
          assert.ok(dbData.players.every((p) => p.homegame_id === b));
          assert.equal(playerStatistics(pa[0], da).net, 1500);
          assert.equal(playerStatistics(pb[0], dbData).net, 0);
          assert.equal(buildBackup({ id: a, name: "A" }, da).games.length, 1);
          assert.equal(
            buildBackup({ id: b, name: "B" }, dbData).games.length,
            0,
          );
          await assert.rejects(
            rpc("start_game", [a, "Duplicate", "2026-09-14", pa]),
            /one_active_game/,
          );
          await assert.rejects(
            rpc("save_player", [b, "Wrong target", pa[0], false]),
            /Player not found/,
          );
          await assert.rejects(
            rpc("start_game", [b, "Mixed", "2026-09-14", pa]),
            /Invalid or archived/,
          );
          assert.deepEqual(await rpc("get_homegame_data", [a]), da);
        },
      );
      await asUser(users[1]);
      const c = await rpc("create_homegame", ["Table C"]);
      const code = await rpc("get_invite_code", [c]);
      await asUser(users[0]);
      await t.test(
        "join preserves A/B, duplicate joins are idempotent",
        async () => {
          await assert.rejects(rpc("get_invite_code", [c]), /Not a member/);
          assert.equal(await rpc("join_homegame_by_code", [code]), c);
          assert.equal(await rpc("join_homegame_by_code", [code]), c);
          assert.deepEqual(
            new Set((await list()).map((g) => g.id)),
            new Set([a, b, c]),
          );
          assert.equal(
            (await db.query("select * from public.homegame_members")).rows
              .length,
            3,
          );
        },
      );
      await asUser(users[2]);
      await t.test(
        "unrelated identities cannot list groups, spoof membership or access any target",
        async () => {
          assert.deepEqual(await list(), []);
          for (const id of [a, b, c]) {
            await assert.rejects(
              rpc("get_homegame_data", [id]),
              /Not a member/,
            );
            await assert.rejects(rpc("get_invite_code", [id]), /Not a member/);
            await assert.rejects(
              rpc("save_player", [id, "Intruder"]),
              /Not a member/,
            );
          }
          await assert.rejects(
            db.query(
              "insert into public.homegame_members(homegame_id,user_id) values($1,$2)",
              [a, users[2]],
            ),
            /permission denied/,
          );
          await assert.rejects(
            rpc("update_game_input", [activeA, pa[0], 1]),
            /Not a member/,
          );
          await assert.rejects(
            rpc("delete_game", [activeB, 0]),
            /Not a member/,
          );
        },
      );
    } finally {
      await db.close();
    }
  });
