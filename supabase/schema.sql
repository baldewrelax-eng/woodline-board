-- Run once in the Supabase SQL Editor as the project owner.
-- Each authenticated account owns one private workspace. No public read/write access.
begin;
create table if not exists public.woodline_boards (
  owner uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 2000000),
  revision bigint not null default 1 check (revision > 0),
  mutation_id text not null,
  updated_at timestamptz not null default now()
);
alter table public.woodline_boards enable row level security;
revoke all on table public.woodline_boards from anon, authenticated;
grant select on table public.woodline_boards to authenticated;
drop policy if exists woodline_owner_read on public.woodline_boards;
create policy woodline_owner_read on public.woodline_boards
  for select to authenticated using ((select auth.uid()) = owner);

-- Bounded, private recovery history. Last 50 complete server-acknowledged versions per account.
create table if not exists public.woodline_board_history (
  owner uuid not null references auth.users(id) on delete cascade,
  revision bigint not null,
  payload jsonb not null,
  updated_at timestamptz not null,
  primary key(owner, revision)
);
alter table public.woodline_board_history enable row level security;
revoke all on table public.woodline_board_history from anon, authenticated;
grant select on table public.woodline_board_history to authenticated;
drop policy if exists woodline_history_owner_read on public.woodline_board_history;
create policy woodline_history_owner_read on public.woodline_board_history
  for select to authenticated using ((select auth.uid()) = owner);

-- All mutations go through this compare-and-swap function. Direct writes are revoked,
-- so a browser cannot bypass the revision check by issuing PATCH requests.
create or replace function public.woodline_save_board(
  p_payload jsonb,
  p_expected_revision bigint,
  p_mutation_id text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  saved public.woodline_boards%rowtype;
begin
  if uid is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_expected_revision is null or p_expected_revision < 0 then raise exception 'Invalid revision'; end if;
  if p_mutation_id is null or length(p_mutation_id) < 8 or length(p_mutation_id) > 128 then raise exception 'Invalid mutation id'; end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' or octet_length(p_payload::text) > 2000000 then raise exception 'Invalid board payload'; end if;

  -- Retry of an acknowledged-or-lost request must never create a second revision.
  select * into saved from public.woodline_boards where owner = uid;
  if found and saved.mutation_id = p_mutation_id then
    if saved.payload <> p_payload then raise exception 'Mutation id reused with different payload'; end if;
    return jsonb_build_object('conflict', false, 'board', jsonb_build_object('payload', saved.payload, 'revision', saved.revision, 'updated_at', saved.updated_at, 'mutation_id', saved.mutation_id));
  end if;

  if p_expected_revision = 0 then
    insert into public.woodline_boards(owner, payload, revision, mutation_id)
      values (uid, p_payload, 1, p_mutation_id)
      on conflict (owner) do nothing returning * into saved;
  else
    update public.woodline_boards set payload = p_payload,
      revision = revision + 1, mutation_id = p_mutation_id, updated_at = clock_timestamp()
      where owner = uid and revision = p_expected_revision returning * into saved;
  end if;
  if found then
    insert into public.woodline_board_history(owner, revision, payload, updated_at)
      values (uid, saved.revision, saved.payload, saved.updated_at)
      on conflict (owner, revision) do nothing;
    delete from public.woodline_board_history where owner = uid and revision <= saved.revision - 50;
    return jsonb_build_object('conflict', false, 'board', jsonb_build_object('payload', saved.payload, 'revision', saved.revision, 'updated_at', saved.updated_at, 'mutation_id', saved.mutation_id));
  end if;

  select * into saved from public.woodline_boards where owner = uid;
  -- A simultaneous retry may have won the initial insert/update. Treat it as success.
  if found and saved.mutation_id = p_mutation_id and saved.payload = p_payload then
    return jsonb_build_object('conflict', false, 'board', jsonb_build_object('payload', saved.payload, 'revision', saved.revision, 'updated_at', saved.updated_at, 'mutation_id', saved.mutation_id));
  end if;
  return jsonb_build_object('conflict', true, 'board', case when saved.owner is null then null else jsonb_build_object('payload', saved.payload, 'revision', saved.revision, 'updated_at', saved.updated_at, 'mutation_id', saved.mutation_id) end);
end;
$$;
revoke all on function public.woodline_save_board(jsonb, bigint, text) from public, anon;
grant execute on function public.woodline_save_board(jsonb, bigint, text) to authenticated;
commit;
