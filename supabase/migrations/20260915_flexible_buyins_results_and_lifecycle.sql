-- Existing projects: run this migration once (safe to rerun), not schema.sql.
-- Existing final chip values, including zeros, remain entered: V2 could not distinguish blanks.
begin;
alter table public.games add column if not exists buy_in_mode text not null default 'fixed';
alter table public.games add column if not exists buy_in_value_cents bigint default 1500;
alter table public.game_players add column if not exists amount_in_cents bigint;
alter table public.game_players add column if not exists result_entry_mode text not null default 'final_chips';
alter table public.game_players add column if not exists result_entry_cents bigint;
alter table public.game_players add column if not exists input_revision integer not null default 0;
alter table public.game_players alter column buy_ins drop not null;
alter table public.game_players alter column final_chips_cents drop not null;
alter table public.game_players alter column final_chips_cents drop default;
update public.game_players set amount_in_cents=coalesce(amount_paid_cents,buy_ins*1500) where amount_in_cents is null;
update public.game_players set result_entry_cents=final_chips_cents where result_entry_cents is null and final_chips_cents is not null;
alter table public.game_players alter column amount_in_cents set not null;
alter table public.game_players alter column amount_in_cents set default 0;
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='public.games'::regclass and conname='game_buy_in_mode') then
 alter table public.games add constraint game_buy_in_mode check((buy_in_mode='fixed' and buy_in_value_cents is not null and buy_in_value_cents between 1 and 100000000) or (buy_in_mode='flexible' and buy_in_value_cents is null));
 end if;
 if not exists(select 1 from pg_constraint where conrelid='public.game_players'::regclass and conname='player_entry_valid') then
 alter table public.game_players add constraint player_entry_valid check(amount_in_cents between 0 and 100000000 and result_entry_mode in ('final_chips','net_pl') and (result_entry_cents is null or result_entry_cents between -100000000 and 100000000));
 end if;
end $$;

-- Derived fields cannot drift, even inside RPCs. Parent settings are immutable.
create or replace function private.derive_game_player() returns trigger language plpgsql set search_path='' as $$
declare g public.games;
begin
 select * into g from public.games where id=new.game_id;
 if g.buy_in_mode='fixed' then
   if new.buy_ins is null then raise exception 'Fixed games require a buy-in count'; end if;
   new.amount_in_cents:=new.buy_ins::bigint*g.buy_in_value_cents;
 else
   if new.buy_ins is not null then raise exception 'Flexible games do not have buy-in counts'; end if;
 end if;
 new.final_chips_cents:=case when new.result_entry_cents is null then null when new.result_entry_mode='net_pl' then new.amount_in_cents+new.result_entry_cents else new.result_entry_cents end;
 if new.final_chips_cents<0 then raise exception 'Net P/L would produce negative final chips'; end if;
 if tg_op='UPDATE' then new.input_revision:=old.input_revision+1; end if;
 return new;
end $$;
drop trigger if exists derive_game_player on public.game_players;
create trigger derive_game_player before insert or update on public.game_players for each row execute function private.derive_game_player();
create or replace function private.immutable_buy_in_mode() returns trigger language plpgsql set search_path='' as $$
begin
 if new.buy_in_mode is distinct from old.buy_in_mode or new.buy_in_value_cents is distinct from old.buy_in_value_cents then raise exception 'Buy-in tracking is fixed once a game starts'; end if;
 return new;
end $$;
drop trigger if exists immutable_buy_in_mode on public.games;
create trigger immutable_buy_in_mode before update on public.games for each row execute function private.immutable_buy_in_mode();

-- Replace only the old function signature; no table or data is dropped.
drop function if exists public.start_game(uuid,text,date,uuid[]);
create or replace function public.start_game(p_homegame uuid,p_name text,p_date date,p_players uuid[],p_buy_in_mode text default 'fixed',p_buy_in_value_cents bigint default 1500) returns uuid language plpgsql security definer set search_path='' as $$
declare g uuid;
begin
 if not private.is_member(p_homegame) then raise exception 'Not a member'; end if;
 if p_players is null or cardinality(p_players) not between 2 and 22 then raise exception 'Choose 2 to 22 players'; end if;
 if (select count(*) from public.players where id=any(p_players) and homegame_id=p_homegame and not archived)<>cardinality(p_players) then raise exception 'Invalid or archived players'; end if;
 insert into public.games(homegame_id,name,game_date,created_by,buy_in_mode,buy_in_value_cents) values(p_homegame,btrim(p_name),p_date,auth.uid(),p_buy_in_mode,case when p_buy_in_mode='fixed' then p_buy_in_value_cents else null end) returning id into g;
 insert into public.game_players(homegame_id,game_id,player_id,player_name_snapshot,buy_ins,amount_in_cents,result_entry_cents)
 select p_homegame,g,id,name,case when p_buy_in_mode='fixed' then 1 else null end,0,null from public.players where id=any(p_players);
 update public.homegames set revision=revision+1 where id=p_homegame;
 return g;
end $$;

-- Atomic fixed increments. Legacy chip arguments remain supported for older clients.
create or replace function public.update_game_input(p_game uuid,p_player uuid,p_delta integer default null,p_chips bigint default null,p_expected_chips bigint default null) returns void language plpgsql security definer set search_path='' as $$
declare g public.games;
begin
 select * into g from public.games where id=p_game for update;
 if not private.is_member(g.homegame_id) then raise exception 'Not a member'; end if;
 if g.status<>'active' then raise exception 'This game is already completed. Open History to correct it.'; end if;
 if p_delta is not null and (p_delta not in (-1,1) or g.buy_in_mode<>'fixed') then raise exception 'Invalid buy-in change'; end if;
 update public.game_players set buy_ins=case when p_delta is null then buy_ins else buy_ins+p_delta end,
 result_entry_mode=case when p_chips is null then result_entry_mode else 'final_chips' end,
 result_entry_cents=coalesce(p_chips,result_entry_cents)
 where game_id=p_game and player_id=p_player and (p_chips is null or coalesce(final_chips_cents,0)=p_expected_chips);
 if not found then raise exception 'This entry changed on another device. Reload and retry your input.'; end if;
 update public.games set revision=revision+1 where id=p_game;
end $$;

create or replace function public.save_game_entry(p_game uuid,p_player uuid,p_revision integer,p_amount bigint default null,p_result_mode text default null,p_result_cents bigint default null,p_save_result boolean default false) returns void language plpgsql security definer set search_path='' as $$
declare g public.games;
begin
 select * into g from public.games where id=p_game for update;
 if not private.is_member(g.homegame_id) then raise exception 'Not a member'; end if;
 if g.status<>'active' then raise exception 'This game is already completed'; end if;
 if p_amount is not null and g.buy_in_mode<>'flexible' then raise exception 'Fixed games use buy-in counts'; end if;
 if p_save_result and (p_result_mode is null or p_result_mode not in ('final_chips','net_pl')) then raise exception 'Invalid result source'; end if;
 update public.game_players set amount_in_cents=coalesce(p_amount,amount_in_cents),
 result_entry_mode=case when p_save_result then p_result_mode else result_entry_mode end,
 result_entry_cents=case when p_save_result then p_result_cents else result_entry_cents end
 where game_id=p_game and player_id=p_player and input_revision=p_revision;
 if not found then raise exception 'This entry changed on another device. Discard your draft to load the latest entry, then retry.'; end if;
 update public.games set revision=revision+1 where id=p_game;
end $$;

create or replace function public.leave_homegame(p_homegame uuid) returns void language plpgsql security definer set search_path='' as $$
declare h public.homegames;
begin
 select * into h from public.homegames where id=p_homegame for update;
 if not private.is_member(p_homegame) then raise exception 'Not a member'; end if;
 if h.created_by=auth.uid() then raise exception 'You created this homegame. Delete it instead.'; end if;
 delete from public.homegame_members where homegame_id=p_homegame and user_id=auth.uid();
end $$;
create or replace function public.delete_homegame(p_homegame uuid) returns void language plpgsql security definer set search_path='' as $$
declare h public.homegames;
begin
 select * into h from public.homegames where id=p_homegame for update;
 if not private.is_member(p_homegame) or h.created_by is distinct from auth.uid() then raise exception 'Only the owner can delete this homegame'; end if;
 -- Remove games first so participant foreign keys never block deleting players.
 -- Both statements and all dependent cascades form one atomic transaction.
 delete from public.games where homegame_id=p_homegame;
 delete from public.homegames where id=p_homegame;
end $$;
create or replace function public.complete_game(p_game uuid,p_revision integer,p_name text,p_date date,p_inputs jsonb,p_payments jsonb) returns void language plpgsql security definer set search_path='' as $$
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
 for r in select * from jsonb_to_recordset(p_inputs) as x(id uuid,"buyIns" integer,"finalChipsCents" bigint,"amountInCents" bigint,"resultEntryMode" text,"resultEntryCents" bigint) loop
 if g.buy_in_mode='flexible' and (r."amountInCents" is null or r."buyIns" is not null or r."resultEntryMode" is null) then raise exception 'Flexible games require amount-in and a result source, without buy-in counts'; end if;
 insert into public.game_players(homegame_id,game_id,player_id,player_name_snapshot,buy_ins,amount_in_cents,result_entry_mode,result_entry_cents)
 select g.homegame_id,p_game,p.id,p.name,case when g.buy_in_mode='fixed' then r."buyIns" else null end,coalesce(r."amountInCents",0),coalesce(r."resultEntryMode",'final_chips'),case when r."resultEntryMode" is null then r."finalChipsCents" else r."resultEntryCents" end from public.players p where p.id=r.id and p.homegame_id=g.homegame_id
 on conflict(game_id,player_id) do update set buy_ins=excluded.buy_ins,amount_in_cents=excluded.amount_in_cents,result_entry_mode=excluded.result_entry_mode,result_entry_cents=excluded.result_entry_cents;
 if not found then raise exception 'Invalid player'; end if;
 end loop;
 if (select count(*) from public.game_players where game_id=p_game)<>n then raise exception 'Duplicate players'; end if;
 if exists(select 1 from public.game_players where game_id=p_game and result_entry_cents is null) then raise exception 'Enter a result for every player before calculating settlement.'; end if;
 update public.game_players set amount_paid_cents=amount_in_cents,raw_result_cents=final_chips_cents-amount_in_cents,variance_adjustment_cents=0 where game_id=p_game;
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
 total_final_chips_cents=(select sum(final_chips_cents) from public.game_players where game_id=p_game),variance_cents=v,calculation_version='3.0-exact-dp' where id=p_game;
 update public.homegames set revision=revision+1 where id=g.homegame_id;
end $$;

revoke all on function private.derive_game_player(),private.immutable_buy_in_mode() from public,anon,authenticated;
revoke all on function public.start_game(uuid,text,date,uuid[],text,bigint),public.save_game_entry(uuid,uuid,integer,bigint,text,bigint,boolean),public.leave_homegame(uuid),public.delete_homegame(uuid) from public,anon;
grant execute on function public.start_game(uuid,text,date,uuid[],text,bigint),public.save_game_entry(uuid,uuid,integer,bigint,text,bigint,boolean),public.leave_homegame(uuid),public.delete_homegame(uuid) to authenticated;
notify pgrst, 'reload schema';
commit;
