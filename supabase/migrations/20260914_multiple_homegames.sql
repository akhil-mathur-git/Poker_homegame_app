-- EXISTING PROJECTS: run this file, NOT schema.sql. Safe to rerun.
-- Keeps every row, foreign key, RLS policy, RPC and composite membership key.
begin;
alter table public.homegame_members
  drop constraint if exists homegame_members_user_id_key;
-- Retain efficient membership lookup after removing the unique index.
create index if not exists homegame_members_user_id_idx
  on public.homegame_members(user_id);
commit;
