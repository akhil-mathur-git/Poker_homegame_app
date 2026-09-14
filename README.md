# Poker Homegame

A shared tracker for your poker groups. Vite + React + JavaScript, Supabase Auth/PostgreSQL/Realtime, and Vercel static hosting. Each game chooses fixed buy-ins (default $15) or flexible amounts. There are no player accounts or email/password forms.

## Existing project: September 15 game-input and lifecycle upgrade

**Keep your existing Supabase project. Run this migration, not `schema.sql`.**

1. Open [Supabase](https://supabase.com/dashboard), select your existing Poker Homegame project, and click **SQL Editor → New query**.
2. Open [`supabase/migrations/20260915_flexible_buyins_results_and_lifecycle.sql`](supabase/migrations/20260915_flexible_buyins_results_and_lifecycle.sql). Copy the **entire file**, paste it into the editor, and click **Run**. This is the only new migration for this upgrade. The earlier multiple-homegame migration below should already be applied if you are using multiple tables.
3. Reload the updated local app (restart `npm run dev` if needed). Existing games will still use fixed $15 buy-ins and their old final-chip entries. Completed financial outputs and settlements are preserved. **Old zero chip values remain entered zeros** because the previous database had no way to distinguish a blank from zero. New games begin with genuinely unentered results.
4. Try a test game: choose **Fixed buy-ins**, change **Buy-in value** to `20.00`, and start. Enter a player's **Net P/L**, tap **Save entry**, then add a buy-in. Net P/L stays fixed and Final Chips increases. Enter Final Chips instead and save: a later buy-in leaves Final Chips fixed and changes Net P/L. Try a separate **Flexible amount** game and enter each player's amount in directly.
5. In **Invite / Settings → Homegame settings**, the creator sees **Delete homegame**; other members see **Leave homegame**. The first click opens a confirmation. Use only a disposable test homegame when trying permanent deletion. Cancel does nothing; confirmation removes only the intended membership or homegame. Another available table is selected afterward, or onboarding is shown if none remain.
6. When you are ready to publish, review and commit/push these code changes yourself using your existing repository workflow. Vercel can deploy them through the existing setup. **No environment variables, API keys, Auth settings, or Vercel configuration changes are required.** Apply the SQL migration before deploying the frontend. Other devices should reload the updated site before editing games with the new tracking modes.

The migration adds `games.buy_in_mode` and `buy_in_value_cents`. It backfills existing games as fixed/$15 and preserves all old snapshots. `game_players` gains `amount_in_cents`, `result_entry_mode`, nullable `result_entry_cents`, and `input_revision`. Flexible games store no buy-in count. A database trigger derives fixed amount-in and final chips from the game settings and the single entered result; it validates the derived value and advances the entry revision. Tracking mode/value are immutable once the game starts, including during historical correction. Existing completed calculation versions stay intact; newly completed/corrected games use `3.0-exact-dp`.

Result sources are `final_chips` or `net_pl`. A null entered value is unentered, while zero is a real result. Both UI fields remain editable; editing the companion switches source. Every participant needs an entered result to settle. Amounts use integer cents, with the existing $1,000,000 per-player amount/final-chip limit and 10,000 fixed-buy-in count limit. Flexible entries are included in total money bought in and all profit statistics; the **Fixed buy-ins** profile statistic counts only fixed-mode games. JSON exports use schema version 3 and include all new game/input fields; older downloaded backups remain unchanged.

`save_game_entry` saves amount-in and/or the result source/value atomically and compares `input_revision` to reject stale saves (including changes made during local editing). Fixed +/− operations remain atomic deltas. Incoming snapshots preserve unsaved drafts; a conflicting save explains how to discard and re-enter it. `complete_game` still locks/checks the game revision, recalculates server-side variance, and validates every transfer. The exact minimum-transfer optimizer and winner-only adjustment rules are unchanged.

`leave_homegame` locks the target group, verifies membership, rejects its creator, and removes only the membership for `auth.uid()`. `delete_homegame` checks `created_by = auth.uid()` and atomically deletes the target games and parent homegame with dependent cascades; deleting games first avoids player-reference ordering issues. The invite stops working. Direct client membership writes remain revoked, all RLS policies remain enabled, and every SECURITY DEFINER RPC fixes an empty search path. Owner identity comes from the authenticated session and database row, never a caller-supplied owner ID. Remote loss of access is detected on the next snapshot refresh (foreground/reconnect or at most the normal 30-second visible-page fallback); the app then clears the stale table and refreshes memberships.

Validation includes a saved V2 schema fixture, populated-history migration and rerun tests, linked-input/source tests, fixed/flexible completion/correction, leave/rejoin, owner-only deletion, cascade isolation, and the existing financial/security suites. Browser tests now execute their database calls against isolated PostgreSQL, with only Auth and Realtime transport simulated. They never contact the deployed Supabase project.

## Existing Supabase project: enable multiple homegames

**Keep your existing project and test data. Do not rerun `schema.sql`.**

1. Open [your Supabase dashboard](https://supabase.com/dashboard) and click your **existing Poker Homegame project**.
2. Click **SQL Editor → New query**.
3. Open [`supabase/migrations/20260914_multiple_homegames.sql`](supabase/migrations/20260914_multiple_homegames.sql) in this repository. Copy the entire file, paste it into the new query, and click **Run**.
4. This removes only `homegame_members_user_id_key`, the `UNIQUE(user_id)` constraint, and adds a non-unique index on `user_id`. It does not delete or change any homegame, membership, player, game, result, settlement, or invite. The composite primary key `(homegame_id, user_id)` remains. The migration is safe to rerun.
5. Locally, restart `npm run dev` if needed, then reload the app. Your current table should still appear. Use **Your tables** in the header to switch groups, **+ Create homegame**, or **+ Join homegame**. Creating/joining selects the new table while keeping previous memberships.
6. To update the live site, review and commit/push the frontend changes yourself when ready. Vercel will deploy the updated repository through your existing setup. **No Vercel environment variables, Supabase keys, Auth settings, or hosting configuration need to change.** No commit, push, deployment, or live SQL execution is performed by the implementation task.
7. Create a second table, add a player there, and switch back: the original table must retain its own players/history. Start one game in each table, switch between them, and reload with the second selected. It should reopen that table. You can join a third table with an invite without losing the first two.

Membership listing uses the existing RLS-protected `homegames` SELECT endpoint; it now fetches the full ordered list rather than `.limit(1)`. The anonymous session remains unchanged. `selectedHomegameId` remembers only a browser preference under `poker-selected-homegame-id`. Startup checks that ID against the memberships returned by Supabase, falls back to the oldest accessible homegame (ID breaks ties), or shows onboarding when there are none. It is never used as an authorization boundary.

Each selected table mounts a separate keyed view. Switching resets navigation, selected games, player profiles, chip drafts and invite/copy state; unsubscribes the old Realtime channel; and loads the new table's snapshot. Pending old fetches are invalidated, and late channel callbacks are ignored. Switching is disabled during a save and asks before discarding unsaved game inputs. Backups name the selected table in the UI and JSON; filenames include its UUID to distinguish groups with identical names.

Tests cover fresh and migrated databases, unchanged existing data, repeat migration, A/B creation, C joining, duplicate joins, per-group active games/statistics/backups, and unauthorized identities. Browser fixtures cover switching both ways, selection after reload, invalid stored selection, a delayed previous-table snapshot, and old subscription cleanup. The browser fixture backend is intercepted before navigation, so it never calls the real project even when `.env.local` is configured.

## First-time setup — do these steps in order

You need a Supabase account and a Vercel account to manage infrastructure. **Your friends do not need either account.** Nothing has been deployed or pushed for you.

1. Open [Supabase](https://supabase.com/dashboard), sign in, and click **New project**. Choose your free organization (create one on the **Free** plan if prompted). Name the project `Poker Homegame`, generate a database password and keep it in your password manager, choose a nearby region, and click **Create new project**. Wait for provisioning. The database password never goes in this React app.
2. In that project, open **SQL Editor → New query**. Open [`supabase/schema.sql`](supabase/schema.sql) in this repository, copy the **entire file**, paste it into the editor, and click **Run**. Run it once in a fresh project. The file creates the tables, functions, access rules, and Realtime publication entries in one transaction. It intentionally does not drop existing tables or overwrite data.
3. Open **Authentication → Sign In / Providers**. Find **Anonymous Sign-Ins**, enable **Allow anonymous sign-ins**, and save. The dashboard may label this section **Providers**. You do not need to set up email/password or an email server. Leave CAPTCHA disabled for this implementation; it does not yet include a CAPTCHA token widget.
4. Click the project's **Connect** button. Copy the **Project URL** and **Publishable key** (`sb_publishable_...`). You can also find keys under **Settings → API Keys**. Do **not** copy a secret key (`sb_secret_...`) or a `service_role` key. A legacy public `anon` key also works, but prefer the publishable key.
5. In this repository's top-level folder, make a copy of [`.env.example`](.env.example) named **`.env.local`**. Replace the two placeholder values:

   ```dotenv
   VITE_SUPABASE_URL=https://your-project-reference.supabase.co
   VITE_SUPABASE_ANON_KEY=your-publishable-key
   ```

   Keep these variable names exactly, even if you use a publishable key. `.env.local` is ignored by Git. Both values are expected to be visible in the browser; the SQL access rules protect the data.

6. Open a terminal in this project and run **`npm install`**, then **`npm run dev`**. Open the local URL printed in the terminal. If a dev server was already running, stop it with Ctrl+C and restart it so it picks up the variables. Click **Create homegame**, add players under **Players**, and try a game. If you see “Connect your homegame,” recheck step 5.
7. When you have reviewed the code and are ready, commit and push these changes to **your existing GitHub repository** using your usual Git workflow. No commit or push has been performed by this task. Do not include `.env.local`.
8. Open [Vercel](https://vercel.com/new), sign in using GitHub, and choose your personal **Hobby** plan. Click **Add New → Project**, find this existing repository, and click **Import**. If it is missing, click the GitHub permissions/configuration option and grant Vercel access to this repository.
9. In the Vercel import screen, choose **Vite** as the Framework Preset if it was not detected. Leave Root Directory at the repository root. Use **`npm run build`** for Build Command and **`dist`** for Output Directory. Expand **Environment Variables** and add the exact two names and values from step 5. Include **Production**; include **Preview** only if you want preview deployments to access this same real database. Click **Deploy**.
10. When deployment finishes, click **Visit** and copy your `https://...vercel.app` URL. In Supabase open **Authentication → URL Configuration**, put that URL in **Site URL**, and save. This app does not use auth redirects, but this sets the correct project website. If you later change a Vercel environment variable, open **Deployments → latest deployment → ⋯ → Redeploy**; Vite embeds variables at build time.
11. Open the production URL. This is a different browser origin from localhost, so it gets a different anonymous identity. If you created your real homegame locally, open its **Invite / Settings → Show & copy invite code**, then **Join** that homegame on the production site. **Do not create a second homegame unless you want separate data.** Keep the invite code somewhere safe.
12. Send your friend the website URL and invite code. On their phone they open the URL, paste the code, and tap **Join homegame**. Follow the two-device checks below before using it for a real game.

These instructions use the current [Supabase anonymous-auth documentation](https://supabase.com/docs/guides/auth/auth-anonymous), [public key documentation](https://supabase.com/docs/guides/getting-started/api-keys), and [Vercel Vite guide](https://vercel.com/docs/frameworks/frontend/vite).

## Two-device check before a real game

Use two browsers/devices, both joined to the same homegame. A private browser window works as the second device, but its session disappears when the window closes.

1. On device A, create two or more players and start a game. On B, check that **Current game** appears without a page reload and open it.
2. On A, tap a player's **+** buy-in button. B should update. Tap **+** on both devices; both increments should count.
3. On A, type final chips. Until you tap **Save entry**, the input is explicitly unsaved. After saving, B should see it. If both devices edit the same player entry from an old revision, the second save should be rejected. Note the desired value, use **Discard** to accept the shared value, and enter/save it again if needed.
4. Enter a valid set of chip values, then **Calculate settlement → Complete & save game**. Check Home, History, the leaderboard, and player profiles on both devices. The active game should disappear.
5. Reload both browsers. The same membership, players, completed game and results should remain. Close A entirely, then create/play a game using B alone.
6. Edit a completed game in History, recalculate, and save. The statistics should change. Rename and archive a player: the old game should keep its recorded name; the archived player should retain their profile and disappear from new-game selection.
7. In History, delete a test game after confirming. Its results should disappear from statistics. In Settings, export a backup and check that it contains players, completed games, game player records and settlements.
8. Temporarily disconnect a device. Check the offline indicator and retry behavior. A failed save must not look successful. Restore the connection and use **Refresh** if necessary.
9. In Supabase, open **Authentication → Users** and confirm devices appear as anonymous users. In **Database → Publications**, confirm `supabase_realtime` contains `homegames` and `games`; the SQL already adds them. There is intentionally no need to subscribe to `game_players` because every input update changes its parent game's revision.

For an additional hosted security check, use an unrelated private-browser identity to create a different homegame. In its browser developer console, use the signed-in Supabase client via `const { supabase } = await import('/src/lib/supabase.js')` **only on the local Vite development site**, then request another group's ID with `.from('games').select('*').eq('homegame_id', 'OTHER_GROUP_UUID')`. It should return no rows. Calling `get_homegame_data` or a write RPC for that group should fail. Direct membership insertion must fail even for your own user. Do not paste an access token into shared messages.

## What is implemented

- **Home:** current game, recent games, all-time leaderboard, and compact Home / Players / History navigation.
- **New game:** persistent player selection, new players, name/date, configurable fixed buy-ins or direct flexible amounts. Fixed participants start with one buy-in; flexible participants start with $0 in. All new results start blank. The database allows only one active game per homegame.
- **Active game:** atomic buy-in increments, per-player amount/result saves, collected/chip/variance totals, calculation preview, copyable settlement, and atomic completion.
- **History:** stored financial snapshots, name/date/input corrections, participant additions/removals while correcting, recalculation, and confirmed deletion. Corrections keep a game completed while being edited, so a separate active game is unaffected.
- **Players:** normalized unique names, rename, archive/restore, profiles, ten useful statistics, and a lightweight cumulative-profit SVG chart.
- **Backup:** schema-versioned JSON export of all players and completed games/results/payments. No blind restore/import endpoint. Invite codes and device auth identities are omitted.
- **V1:** the old `poker-homegame-v1` localStorage value is untouched and can be exported in Settings. It held a draft only, so there is no automatic conversion into completed history. Re-enter a meaningful V1 draft as a new game if desired.

## Data and access model

`homegames`, `homegame_members`, `players`, `games`, `game_players`, and `settlements` are normalized tables. Private invite codes live in `private.invites`, outside the public API schema. Cents are PostgreSQL integer/bigint values; inputs are bounded so all browser arithmetic stays within safe integer range.

Supabase automatically creates or restores an anonymous session for the browser. This UUID is a **device/app identity**, unrelated to poker players. Each device can belong to multiple homegames, and multiple devices can join the same homegame. The header switcher chooses which group is displayed. A user never has to identify which poker player they are.

Codes contain 32 hexadecimal characters from a cryptographically generated UUID (122 random bits). `create_homegame` atomically creates the group, invite, and membership. `join_homegame_by_code` validates the code on the database server and inserts membership for `auth.uid()`; it never accepts a caller-supplied member UUID. All members can retrieve/copy their own group's code. All members can edit games, including corrections and confirmed game deletion. Only the creator can delete the entire homegame; other members can leave it.

### Security review

- RLS is enabled on **every application table**, including private invites. Read policies require membership; members can read only their own membership row.
- Browser roles have **no direct table write privileges** and there are no write policies. Membership cannot be inserted or edited directly. Writes use narrowly scoped RPCs with explicit membership checks.
- Composite foreign keys prevent linking game/player rows across homegames. No RPC accepts an alternative homegame for an existing game's update. A manipulated frontend request cannot move a game into another group.
- Invite rows have no read policy or client table grants. Only the member-checked invite RPC reveals a group's code. Joining has a generic invalid-code error. The long random code protects against guessing; there is no custom join-attempt limiter in this small application.
- Every `SECURITY DEFINER` function fixes `search_path = ''` and schema-qualifies application objects. Default PUBLIC/anon execution rights are explicitly revoked; only authenticated sessions may call the app RPCs. The internal membership helper avoids recursive membership RLS.
- Completion locks the game row, checks the expected revision, recomputes variance and per-player outputs in PostgreSQL, verifies that transfers go only from debtors to creditors, and verifies each balance settles exactly. Any error rolls the entire operation back. Exact transfer minimization is performed by the frontend's tested pure optimizer; the database checks financial validity rather than rerunning the exponential optimizer.
- No service-role credential is required or included. The client rejects recognizable secret/service-role keys to catch configuration mistakes, but this guard is not a substitute for keeping secrets out of Vite environment variables.

### Synchronization and concurrency

PostgreSQL is the source of truth. The app subscribes to only the current group's `homegames` and `games` update signals. Input RPCs update one player field and increment the parent game's revision in the same transaction. Player changes, game creation/completion and deletion increment the group's revision. A short debounce fetches a consistent group snapshot through an RLS-protected read RPC. The tiny homegame dataset is fetched as a whole for simplicity; updates never replace one shared JSON blob.

Subscriptions and listeners are cleaned up on unmount. Reconnect/foreground events refresh data, and visible pages have a 30-second fallback refresh. The header reports socket availability; **Live** means the subscription is connected, not that unsaved fields were saved.

Buy-in deltas run under a row lock, avoiding lost increments. Amount/result saves compare the player entry revision; conflicting edits are rejected. Completion/correction/deletion compare game revisions. Unsaved chips and historical edits stay in component state across incoming updates; leaving the view or closing the page warns about losing them. Failed requests keep editable input available. There is no offline write queue or automatic retry of increments: if an acknowledgment is lost, refresh first to see whether the server applied it.

### Financial calculations

[`src/calculations.js`](src/calculations.js) preserves the working V1 integer-money parsing, largest-remainder variance allocation and exact subset dynamic-programming settlement optimizer. Input limits, stable player-ID ordering, duplicate-ID checks and transparent copied results were added.

Variance is `final chips − money collected`. Only raw winners absorb it, in proportion to raw winning cents. Integer division and largest remainders assign leftover cents deterministically by player ID; a negative variance increases winner payouts. No-winner nonzero variance or a winner becoming a debtor is an error. Final results sum to exactly zero.

The optimizer maximizes disjoint zero-sum groups using subset DP, then settles each group exclusively debtor → creditor. This gives the minimum number of nonzero transfers, rather than claiming a basic greedy result is optimal. There is a **22-player cap** because exact optimization has exponential time/memory cost; normal small homegames are much faster. The same player-ID order controls rounding and deterministic ties.

Completed games store name snapshots, inputs, raw/adjusted outputs, transfers and a calculation version (`3.0-exact-dp` for new saves, with older versions retained in history). History displays those saved values rather than silently recomputing old games with new code. Statistics and the leaderboard derive exclusively from completed, final adjusted results. They have no separately incremented totals to drift out of sync.

## Development and verification

Use a current Node LTS compatible with Vite 8 (Node 22.12+ recommended).

```sh
npm install
npm run dev
npm run lint
npm test
npm run build
npm run preview
```

- Financial tests cover zero/positive/negative variance, rounding ties, invalid inputs, winner-only transfers, exact optimization against an independent exhaustive oracle, and copy output.
- Statistics/backup tests cover completed-only aggregation, chronology, corrections/deletions, and backup scope.
- Database tests use **PGlite (real PostgreSQL compiled to WASM)** as a test-only dependency. They run the migration and exercise RLS, grants, invite joining, membership spoofing, cross-group reads/writes, atomic rollback, input conflicts, completion, correction and deletion. Supabase's `auth.users` and `auth.uid()` are locally shimmed. These tests do not validate Supabase's hosted JWT/session service or actual Realtime sockets.
- `tests/browser-smoke.mjs` is an optional Playwright/Chrome test using an intercepted database module backed by isolated PostgreSQL. Auth sessions and Realtime transport are simulated; SQL and RLS are exercised. It covers the rendered workflow at 375px and 1280px, with screenshots and browser-error/overflow checks. Run `node tests/browser-smoke.mjs` with Vite running and Playwright available, or set `PLAYWRIGHT_MODULE_PATH` to an existing Playwright module path. Playwright is not a production dependency. The test intercepts the backend module before navigation, including the missing-configuration screen, so configured local credentials are not used. This is UI verification, not a live cloud integration test.

### File map

| Files                                                                                       | Purpose                                                                             |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `src/App.jsx`, `src/App.css`, `src/index.css`                                               | Auth startup, navigation, dashboard, new game, settings, responsive design          |
| `src/components/GameView.jsx`, `Results.jsx`, `PlayersView.jsx`                             | Shared game entry/corrections, results/payments, player profiles/chart              |
| `src/calculations.js`                                                                       | Pure integer-cent calculations and exact optimizer                                  |
| `src/components/HomegameDangerZone.jsx`                                                     | Accessible leave/delete confirmation dialog                                         |
| `supabase/migrations/20260915_flexible_buyins_results_and_lifecycle.sql`                    | Existing-project input/lifecycle upgrade                                            |
| `tests/game-inputs.test.js`, `tests/game-lifecycle.test.js`, `tests/fixtures/schema-v2.sql` | Source linking, preserved-history migration, financial and lifecycle security tests |
| `src/lib/homegames.js`                                                                      | Validated selected-table preference; no poker data stored locally                   |
| `supabase/migrations/20260914_multiple_homegames.sql`                                       | Data-preserving upgrade for existing projects                                       |
| `src/lib/supabase.js`                                                                       | Public client, anonymous session, RPC/read adapters, saved-result mapping           |
| `src/lib/statistics.js`, `backup.js`                                                        | Derived statistics and versioned exports                                            |
| `supabase/schema.sql`                                                                       | Tables, constraints, indexes, RLS, safe RPCs, Realtime publication                  |
| `tests/`                                                                                    | Financial/statistics/database tests and optional UI smoke test                      |
| `.env.example`, `.gitignore`                                                                | Configuration template and local environment exclusion                              |
| `package.json`, `package-lock.json`                                                         | Supabase client and test-only PGlite dependency; test command                       |
| `index.html`, `public/favicon.svg`, `src/main.jsx`                                          | Page metadata, subtle spade icon, existing React entrypoint                         |

## Free-tier limits and known limitations

This uses no paid APIs, serverless functions, uploads, or custom backend host. [Supabase Free](https://supabase.com/pricing) and [Vercel Hobby](https://vercel.com/docs/plans/hobby) fit a small personal homegame within their quotas. Supabase says free projects may pause after a week of inactivity: if the website cannot connect before a game, open the Supabase dashboard and restore the paused project. There is no artificial keep-alive job or paid upgrade requirement.

Anonymous sign-in endpoints are internet-accessible. Supabase applies an IP rate limit and recommends CAPTCHA to reduce abuse; this version relies on the default rate limit and does not yet integrate CAPTCHA. An invite protects your group's data, but it does not prevent someone creating anonymous users or their own groups. Check Supabase usage occasionally, and add the recommended CAPTCHA integration before broadly publicizing the app. See [Supabase's abuse-prevention guidance](https://supabase.com/docs/guides/auth/auth-anonymous#abuse-prevention-and-rate-limits).

There is no ownership transfer, invite rotation UI, account recovery, offline sync, restore import, or change audit log. Owners delete their groups; other members can leave and later rejoin. Share codes only within your trusted group. Clearing browser data loses that device's identity, not the shared games; rejoin using the invite. Do not delete anonymous auth users casually in the Supabase dashboard: memberships and creator references depend on them.

Hosted anonymous session creation, two-device Realtime delivery, production persistence and Vercel deployment still require the real project setup and manual checks above. No live credentials were available during local implementation, and no successful live integration is claimed.
