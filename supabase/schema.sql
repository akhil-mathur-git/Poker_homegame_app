-- Run once in a new Supabase project's SQL Editor. All money is integer cents.
begin;
create schema if not exists private;
revoke all on schema private from public;
create table public.homegames (
 id uuid primary key default gen_random_uuid(), name text not null check(length(name) between 1 and 80),
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now(), revision integer not null default 0
);
create table public.homegame_members (
 homegame_id uuid not null references public.homegames(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade, joined_at timestamptz not null default now(),
 primary key(homegame_id,user_id), unique(user_id)
);
create table private.invites (
 homegame_id uuid primary key references public.homegames(id) on delete cascade,
 code text unique not null default upper(replace(gen_random_uuid()::text,'-',''))
);
create table public.players (
 id uuid primary key default gen_random_uuid(), homegame_id uuid not null references public.homegames(id) on delete cascade,
 name text not null check(length(name) between 1 and 40),
 normalized_name text generated always as (lower(regexp_replace(btrim(name),'\s+',' ','g'))) stored,
 archived boolean not null default false, created_at timestamptz not null default now(),
 unique(homegame_id,normalized_name), unique(id,homegame_id)
);
create table public.games (
 id uuid primary key default gen_random_uuid(), homegame_id uuid not null references public.homegames(id) on delete cascade,
 name text not null check(length(name) between 1 and 80), game_date date not null,
 status text not null default 'active' check(status in ('active','completed')),
 revision integer not null default 0, total_buy_ins integer, total_collected_cents bigint,
 total_final_chips_cents bigint, variance_cents bigint, calculation_version text,
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now(), completed_at timestamptz,
 unique(id,homegame_id)
);
create unique index one_active_game on public.games(homegame_id) where status='active';
create index games_history on public.games(homegame_id,game_date desc);
create table public.game_players (
 id uuid primary key default gen_random_uuid(), homegame_id uuid not null, game_id uuid not null,
 player_id uuid not null, player_name_snapshot text not null,
 buy_ins integer not null default 1 check(buy_ins between 0 and 10000),
 final_chips_cents bigint not null default 0 check(final_chips_cents between 0 and 100000000),
 amount_paid_cents bigint, raw_result_cents bigint, variance_adjustment_cents bigint, final_result_cents bigint,
 foreign key(game_id,homegame_id) references public.games(id,homegame_id) on delete cascade,
 foreign key(player_id,homegame_id) references public.players(id,homegame_id), unique(game_id,player_id)
);
create index game_players_group on public.game_players(homegame_id);
create index game_players_player on public.game_players(player_id);
create table public.settlements (
 id uuid primary key default gen_random_uuid(), homegame_id uuid not null, game_id uuid not null,
 from_player_id uuid not null, to_player_id uuid not null,
 from_player_name_snapshot text not null, to_player_name_snapshot text not null,
 amount_cents bigint not null check(amount_cents>0), check(from_player_id<>to_player_id),
 foreign key(game_id,homegame_id) references public.games(id,homegame_id) on delete cascade,
 foreign key(game_id,from_player_id) references public.game_players(game_id,player_id) on delete cascade,
 foreign key(game_id,to_player_id) references public.game_players(game_id,player_id) on delete cascade,
 unique(game_id,from_player_id,to_player_id)
);
create index settlements_group on public.settlements(homegame_id);
create function private.is_member(h uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.homegame_members where homegame_id=h and user_id=auth.uid());
$$;
grant usage on schema private to authenticated;
grant execute on function private.is_member(uuid) to authenticated;
-- No direct writes: RPCs below validate membership, lock parent rows, and preserve invariants.
alter table public.homegames enable row level security;
alter table public.homegame_members enable row level security;
alter table public.players enable row level security;
alter table public.games enable row level security;
alter table public.game_players enable row level security;
alter table public.settlements enable row level security;
alter table private.invites enable row level security;
create policy member_read on public.homegames for select to authenticated using(private.is_member(id));
create policy self_read on public.homegame_members for select to authenticated using(user_id=auth.uid());
create policy member_read on public.players for select to authenticated using(private.is_member(homegame_id));
create policy member_read on public.games for select to authenticated using(private.is_member(homegame_id));
create policy member_read on public.game_players for select to authenticated using(private.is_member(homegame_id));
create policy member_read on public.settlements for select to authenticated using(private.is_member(homegame_id));
revoke all on public.homegames,public.homegame_members,public.players,public.games,public.game_players,public.settlements from anon,authenticated;
grant select on public.homegames,public.homegame_members,public.players,public.games,public.game_players,public.settlements to authenticated;

create function public.create_homegame(p_name text) returns uuid language plpgsql security definer set search_path='' as $$
declare h uuid;
begin
 if auth.uid() is null then raise exception 'Sign in first'; end if;
 insert into public.homegames(name,created_by) values(btrim(p_name),auth.uid()) returning id into h;
 insert into public.homegame_members values(h,auth.uid(),now());
 insert into private.invites(homegame_id) values(h);
 return h;
end $$;
create function public.join_homegame_by_code(p_code text) returns uuid language plpgsql security definer set search_path='' as $$
declare h uuid;
begin
 if auth.uid() is null then raise exception 'Sign in first'; end if;
 select homegame_id into h from private.invites where code=upper(regexp_replace(p_code,'[\s-]','','g'));
 if h is null then raise exception 'Invite code not found. Check it with your friend.'; end if;
 insert into public.homegame_members(homegame_id,user_id) values(h,auth.uid()) on conflict(homegame_id,user_id) do nothing;
 return h;
end $$;
create function public.get_invite_code(p_homegame uuid) returns text language plpgsql security definer set search_path='' as $$
begin
 if not private.is_member(p_homegame) then raise exception 'Not a member'; end if;
 return (select code from private.invites where homegame_id=p_homegame);
end $$;
create function public.save_player(p_homegame uuid,p_name text,p_id uuid default null,p_archived boolean default false) returns uuid language plpgsql security definer set search_path='' as $$
declare result uuid;
begin
 if not private.is_member(p_homegame) then raise exception 'Not a member'; end if;
 if p_id is null then
 insert into public.players(homegame_id,name) values(p_homegame,regexp_replace(btrim(p_name),'\s+',' ','g')) returning id into result;
 else
 update public.players set name=regexp_replace(btrim(p_name),'\s+',' ','g'),archived=p_archived where id=p_id and homegame_id=p_homegame returning id into result;
 if result is null then raise exception 'Player not found'; end if;
 end if;
 update public.homegames set revision=revision+1 where id=p_homegame;
 return result;
end $$;
create function public.start_game(p_homegame uuid,p_name text,p_date date,p_players uuid[]) returns uuid language plpgsql security definer set search_path='' as $$
declare g uuid;
begin
 if not private.is_member(p_homegame) then raise exception 'Not a member'; end if;
 if p_players is null or cardinality(p_players) not between 2 and 22 then raise exception 'Choose 2 to 22 players'; end if;
 if (select count(*) from public.players where id=any(p_players) and homegame_id=p_homegame and not archived)<>cardinality(p_players) then raise exception 'Invalid or archived players'; end if;
 insert into public.games(homegame_id,name,game_date,created_by) values(p_homegame,btrim(p_name),p_date,auth.uid()) returning id into g;
 insert into public.game_players(homegame_id,game_id,player_id,player_name_snapshot) select p_homegame,g,id,name from public.players where id=any(p_players);
 update public.homegames set revision=revision+1 where id=p_homegame;
 return g;
end $$;
create function public.update_game_input(p_game uuid,p_player uuid,p_delta integer default null,p_chips bigint default null,p_expected_chips bigint default null) returns void language plpgsql security definer set search_path='' as $$
declare g public.games;
begin
 select * into g from public.games where id=p_game for update;
 if not private.is_member(g.homegame_id) then raise exception 'Not a member'; end if;
 if g.status<>'active' then raise exception 'This game is already completed. Open History to correct it.'; end if;
 if p_delta is not null and p_delta not in (-1,1) then raise exception 'Invalid buy-in change'; end if;
 update public.game_players set buy_ins=buy_ins+coalesce(p_delta,0),final_chips_cents=coalesce(p_chips,final_chips_cents)
 where game_id=p_game and player_id=p_player and (p_chips is null or final_chips_cents=p_expected_chips);
 if not found then raise exception 'This entry changed on another device. Reload and retry your input.'; end if;
 update public.games set revision=revision+1 where id=p_game;
end $$;

-- Completion/correction replaces inputs and outputs atomically, with optimistic concurrency.
-- Variance is recomputed here; caller-supplied financial results are never trusted.
create function public.complete_game(p_game uuid,p_revision integer,p_name text,p_date date,p_inputs jsonb,p_payments jsonb) returns void language plpgsql security definer set search_path='' as $$
declare g public.games; v bigint; profits bigint; allocated bigint; r record; a bigint; n integer;
begin
 select * into g from public.games where id=p_game for update;
 if not private.is_member(g.homegame_id) then raise exception 'Not a member'; end if;
 if g.revision is distinct from p_revision then raise exception 'This game changed on another device. Reload before saving.'; end if;
 if p_inputs is null or jsonb_typeof(p_inputs)<>'array' or p_payments is null or jsonb_typeof(p_payments)<>'array' then raise exception 'Inputs and payments must be arrays'; end if;
 n:=jsonb_array_length(p_inputs);
 if n not between 2 and 22 then raise exception 'Choose 2 to 22 players'; end if;
 -- Keep snapshots for existing participants, including renamed/archived players.
 delete from public.settlements where game_id=p_game;
 delete from public.game_players where game_id=p_game and player_id not in (select (x->>'id')::uuid from jsonb_array_elements(p_inputs) x);
 for r in select * from jsonb_to_recordset(p_inputs) as x(id uuid,"buyIns" integer,"finalChipsCents" bigint) loop
 insert into public.game_players(homegame_id,game_id,player_id,player_name_snapshot,buy_ins,final_chips_cents)
 select g.homegame_id,p_game,p.id,p.name,r."buyIns",r."finalChipsCents" from public.players p where p.id=r.id and p.homegame_id=g.homegame_id
 on conflict(game_id,player_id) do update set buy_ins=excluded.buy_ins,final_chips_cents=excluded.final_chips_cents;
 if not found then raise exception 'Invalid player'; end if;
 end loop;
 if (select count(*) from public.game_players where game_id=p_game)<>n then raise exception 'Duplicate players'; end if;
 update public.game_players set amount_paid_cents=buy_ins*1500,raw_result_cents=final_chips_cents-buy_ins*1500,variance_adjustment_cents=0 where game_id=p_game;
 select sum(raw_result_cents),coalesce(sum(raw_result_cents) filter(where raw_result_cents>0),0) into v,profits from public.game_players where game_id=p_game;
 if v<>0 and profits=0 then raise exception 'No raw winners to absorb variance. Check inputs.'; end if;
 if v>profits then raise exception 'Variance exceeds winner profits'; end if;
 if v<>0 then
 select sum((abs(v)*raw_result_cents)/profits) into allocated from public.game_players where game_id=p_game and raw_result_cents>0;
 for r in select *,row_number() over(order by mod(abs(v)*raw_result_cents,profits) desc,player_id) as rank from public.game_players where game_id=p_game and raw_result_cents>0 loop
 a:=(abs(v)*r.raw_result_cents)/profits + case when r.rank<=abs(v)-allocated then 1 else 0 end;
 update public.game_players set variance_adjustment_cents=-sign(v)*a where id=r.id;
 end loop;
 end if;
 update public.game_players set final_result_cents=raw_result_cents+variance_adjustment_cents where game_id=p_game;
 if exists(select 1 from public.game_players where game_id=p_game and raw_result_cents>0 and final_result_cents<0) then raise exception 'Winner would become a debtor'; end if;
 for r in select * from jsonb_to_recordset(p_payments) as x("fromId" uuid,"toId" uuid,"amountCents" bigint) loop
 insert into public.settlements(homegame_id,game_id,from_player_id,to_player_id,from_player_name_snapshot,to_player_name_snapshot,amount_cents)
 select g.homegame_id,p_game,d.player_id,c.player_id,d.player_name_snapshot,c.player_name_snapshot,r."amountCents"
 from public.game_players d,public.game_players c where d.game_id=p_game and c.game_id=p_game and d.player_id=r."fromId" and c.player_id=r."toId" and d.final_result_cents<0 and c.final_result_cents>0;
 if not found then raise exception 'Transfers must go from debtor to creditor'; end if;
 end loop;
 if exists(select 1 from public.game_players p where p.game_id=p_game and p.final_result_cents <>
 coalesce((select sum(amount_cents) from public.settlements where game_id=p_game and to_player_id=p.player_id),0)-coalesce((select sum(amount_cents) from public.settlements where game_id=p_game and from_player_id=p.player_id),0)) then raise exception 'Payments do not settle every balance'; end if;
 update public.games set name=btrim(p_name),game_date=p_date,status='completed',completed_at=coalesce(completed_at,now()),revision=revision+1,
 total_buy_ins=(select sum(buy_ins) from public.game_players where game_id=p_game),
 total_collected_cents=(select sum(amount_paid_cents) from public.game_players where game_id=p_game),
 total_final_chips_cents=(select sum(final_chips_cents) from public.game_players where game_id=p_game),variance_cents=v,calculation_version='2.0-exact-dp' where id=p_game;
 update public.homegames set revision=revision+1 where id=g.homegame_id;
end $$;
create function public.delete_game(p_game uuid,p_revision integer) returns void language plpgsql security definer set search_path='' as $$
declare g public.games;
begin
 select * into g from public.games where id=p_game for update;
 if not private.is_member(g.homegame_id) then raise exception 'Not a member'; end if;
 if g.revision is distinct from p_revision then raise exception 'Game changed. Reload before deleting.'; end if;
 delete from public.games where id=p_game;
 update public.homegames set revision=revision+1 where id=g.homegame_id;
end $$;
-- PostgreSQL grants PUBLIC execute by default; explicitly restrict every app RPC.
revoke all on function private.is_member(uuid) from public,anon;
revoke all on function public.create_homegame(text),public.join_homegame_by_code(text),public.get_invite_code(uuid),public.save_player(uuid,text,uuid,boolean),public.start_game(uuid,text,date,uuid[]),public.update_game_input(uuid,uuid,integer,bigint,bigint),public.complete_game(uuid,integer,text,date,jsonb,jsonb),public.delete_game(uuid,integer) from public,anon;
grant execute on function public.create_homegame(text),public.join_homegame_by_code(text),public.get_invite_code(uuid),public.save_player(uuid,text,uuid,boolean),public.start_game(uuid,text,date,uuid[]),public.update_game_input(uuid,uuid,integer,bigint,bigint),public.complete_game(uuid,integer,text,date,jsonb,jsonb),public.delete_game(uuid,integer) to authenticated;
create function public.get_homegame_data(p_homegame uuid) returns jsonb language plpgsql stable security invoker set search_path='' as $$
begin
 if not private.is_member(p_homegame) then raise exception 'Not a member'; end if;
 return jsonb_build_object(
 'players',coalesce((select jsonb_agg(p order by p.name) from public.players p where homegame_id=p_homegame),'[]'::jsonb),
 'games',coalesce((select jsonb_agg(g order by g.game_date desc,g.created_at desc) from public.games g where homegame_id=p_homegame),'[]'::jsonb),
 'game_players',coalesce((select jsonb_agg(p order by p.player_id) from public.game_players p where homegame_id=p_homegame),'[]'::jsonb),
 'settlements',coalesce((select jsonb_agg(s order by s.from_player_id,s.to_player_id) from public.settlements s where homegame_id=p_homegame),'[]'::jsonb));
end $$;
revoke all on function public.get_homegame_data(uuid) from public,anon;
grant execute on function public.get_homegame_data(uuid) to authenticated;
-- Only parent change signals are needed: input RPCs bump games.revision.
alter publication supabase_realtime add table public.homegames,public.games;
commit;
