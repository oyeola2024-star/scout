-- =============================================================================
-- SCOUT v10.38.0 FRESH INSTALLATION
-- Run this in a new Supabase project before anyone signs up. It is safe to run again after a partial error.
-- It creates the entire Scout schema, RLS policies, functions, signup provisioning,
-- adaptive sender limits, free basic email verification, team duplicate protection,
-- and server-enforced random 3–6-second workspace dispatch slots.
--
-- This file is intentionally consolidated. Do not run the old standalone repair SQL
-- files after this fresh-install script.
-- Generated from the validated v10.34 working base plus v10.38 adaptive sender-health changes.
-- =============================================================================


-- >>> BEGIN 202607050001_scout_v8_cloud.sql
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role text not null default 'member' check (role in ('admin','member')),
  status text not null default 'approved' check (status in ('approved','disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid references auth.users(id) on delete set null,
  api_key text not null unique default encode(gen_random_bytes(32), 'hex'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.workspaces (id, name)
values ('00000000-0000-4000-8000-000000000001', 'Elevate Scout Team')
on conflict (id) do nothing;

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('admin','member')),
  approved boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists public.import_batches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  file_name text,
  row_count int not null default 0,
  inserted_count int not null default 0,
  skipped_count int not null default 0,
  headers text[] not null default '{}',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.businesses (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  import_batch_id uuid references public.import_batches(id) on delete set null,
  name text,
  email text,
  phone text,
  website text,
  domain text,
  category text,
  location text,
  source text not null default 'manual',
  status text not null default 'pending' check (status in ('pending','scanning','found','ready','review','contacted','responded','no_inbox','bounced','invalid','duplicate','archived')),
  score int,
  normalized_key text not null,
  raw jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, normalized_key)
);

create index if not exists businesses_workspace_status_idx on public.businesses(workspace_id, status);
create index if not exists businesses_workspace_created_idx on public.businesses(workspace_id, created_at desc);
create index if not exists businesses_workspace_email_idx on public.businesses(workspace_id, email);
create index if not exists businesses_workspace_updated_idx on public.businesses(workspace_id, updated_at desc);

create table if not exists public.scout_history (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  normalized_key text not null,
  email text,
  domain text,
  website text,
  name text,
  phone text,
  source text not null default 'scout_app',
  campaign text,
  status text not null default 'scouted',
  raw jsonb not null default '{}'::jsonb,
  scouted_by uuid references auth.users(id) on delete set null,
  scouted_at timestamptz not null default now(),
  unique (workspace_id, normalized_key)
);

create index if not exists scout_history_workspace_key_idx on public.scout_history(workspace_id, normalized_key);

create table if not exists public.email_candidates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  business_id uuid references public.businesses(id) on delete cascade,
  email text not null,
  source text,
  score int,
  status text not null default 'candidate',
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists email_candidates_workspace_business_email_unique on public.email_candidates(workspace_id, business_id, email);
create index if not exists email_candidates_workspace_status_idx on public.email_candidates(workspace_id, status, created_at desc);

create table if not exists public.sent_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  business_id uuid references public.businesses(id) on delete set null,
  to_email text not null,
  from_email text,
  subject text,
  body text,
  provider_message_id text,
  status text not null default 'sent',
  sent_at timestamptz not null default now(),
  raw jsonb not null default '{}'::jsonb
);

create table if not exists public.reply_history (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  business_id uuid references public.businesses(id) on delete set null,
  from_email text,
  to_email text,
  subject text,
  snippet text,
  body text,
  classification text,
  is_real_reply boolean not null default true,
  received_at timestamptz not null default now(),
  raw jsonb not null default '{}'::jsonb
);

create table if not exists public.no_inbox_records (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  business_id uuid references public.businesses(id) on delete set null,
  email text,
  reason text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.templates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  subject text not null,
  message text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);


create table if not exists public.gmail_accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null,
  display_name text,
  status text not null default 'connected',
  backend_ref text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(workspace_id, email)
);

create table if not exists public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  type text not null default 'info',
  message text not null,
  raw jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.email_research_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued','running','done','failed','cancelled')),
  priority int not null default 100,
  attempts int not null default 0,
  last_error text,
  result jsonb not null default '{}'::jsonb,
  requested_by uuid references auth.users(id) on delete set null,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workspace_id, business_id)
);

create index if not exists email_research_jobs_workspace_status_idx on public.email_research_jobs(workspace_id, status, priority desc, created_at);
create index if not exists email_research_jobs_business_idx on public.email_research_jobs(business_id);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at before update on public.profiles for each row execute function public.touch_updated_at();

drop trigger if exists workspaces_touch_updated_at on public.workspaces;
create trigger workspaces_touch_updated_at before update on public.workspaces for each row execute function public.touch_updated_at();

drop trigger if exists businesses_touch_updated_at on public.businesses;
create trigger businesses_touch_updated_at before update on public.businesses for each row execute function public.touch_updated_at();

drop trigger if exists email_research_jobs_touch_updated_at on public.email_research_jobs;
create trigger email_research_jobs_touch_updated_at before update on public.email_research_jobs for each row execute function public.touch_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  admin_email text := 'legacy-admin-disabled@invalid.local';
  default_workspace uuid := '00000000-0000-4000-8000-000000000001';
  new_role text;
begin
  new_role := case when lower(new.email) = admin_email then 'admin' else 'member' end;

  insert into public.profiles (id, email, role, status)
  values (new.id, new.email, new_role, 'approved')
  on conflict (id) do update set email = excluded.email, role = excluded.role, status = 'approved';

  insert into public.workspace_members (workspace_id, user_id, role, approved)
  values (default_workspace, new.id, new_role, true)
  on conflict (workspace_id, user_id) do update set role = excluded.role, approved = true;

  if new_role = 'admin' then
    update public.workspaces set owner_id = new.id where id = default_workspace;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.is_workspace_member(target_workspace uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = target_workspace
      and user_id = auth.uid()
      and approved = true
  );
$$;


create or replace function public.check_existing_normalized_keys(
  target_workspace uuid,
  normalized_keys text[]
)
returns table(normalized_key text, source text)
language sql
security definer
set search_path = public
stable
as $$
  select b.normalized_key, 'queue'::text as source
  from public.businesses b
  where b.workspace_id = target_workspace
    and b.normalized_key = any(normalized_keys)
  union
  select h.normalized_key, 'scout_history'::text as source
  from public.scout_history h
  where h.workspace_id = target_workspace
    and h.normalized_key = any(normalized_keys);
$$;

grant execute on function public.check_existing_normalized_keys(uuid, text[]) to authenticated;

create or replace function public.import_businesses_chunk(
  target_workspace uuid,
  target_batch_id uuid,
  input_rows jsonb
)
returns table(inserted_count int, skipped_queue_count int, skipped_history_count int, skipped_keys text[])
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if not public.is_workspace_member(target_workspace) then
    raise exception 'User is not approved for this workspace';
  end if;

  return query
  with incoming as (
    select
      nullif(trim(x.name), '') as name,
      nullif(trim(lower(x.email)), '') as email,
      nullif(trim(x.phone), '') as phone,
      nullif(trim(x.website), '') as website,
      nullif(trim(x.domain), '') as domain,
      nullif(trim(x.category), '') as category,
      nullif(trim(x.location), '') as location,
      coalesce(nullif(trim(x.source), ''), 'csv_upload') as source,
      nullif(trim(x.normalized_key), '') as normalized_key,
      coalesce(x.raw, '{}'::jsonb) as raw
    from jsonb_to_recordset(coalesce(input_rows, '[]'::jsonb)) as x(
      name text,
      email text,
      phone text,
      website text,
      domain text,
      category text,
      location text,
      source text,
      normalized_key text,
      raw jsonb
    )
    where nullif(trim(x.normalized_key), '') is not null
  ),
  deduped as (
    select distinct on (normalized_key) *
    from incoming
    order by normalized_key
  ),
  queue_existing as (
    select d.normalized_key
    from deduped d
    join public.businesses b
      on b.workspace_id = target_workspace
     and b.normalized_key = d.normalized_key
  ),
  history_existing as (
    select d.normalized_key
    from deduped d
    join public.scout_history h
      on h.workspace_id = target_workspace
     and h.normalized_key = d.normalized_key
    where not exists (select 1 from queue_existing q where q.normalized_key = d.normalized_key)
  ),
  skipped as (
    select normalized_key from queue_existing
    union
    select normalized_key from history_existing
  ),
  inserted as (
    insert into public.businesses (
      workspace_id,
      import_batch_id,
      name,
      email,
      phone,
      website,
      domain,
      category,
      location,
      source,
      status,
      score,
      normalized_key,
      raw,
      created_by
    )
    select
      target_workspace,
      target_batch_id,
      d.name,
      d.email,
      d.phone,
      d.website,
      d.domain,
      d.category,
      d.location,
      d.source,
      case when coalesce(nullif(d.email, ''), '') <> '' then 'ready' else 'pending' end,
      case when coalesce(nullif(d.email, ''), '') <> '' then 75 else null end,
      d.normalized_key,
      d.raw,
      auth.uid()
    from deduped d
    where not exists (select 1 from skipped s where s.normalized_key = d.normalized_key)
    on conflict (workspace_id, normalized_key) do nothing
    returning normalized_key
  )
  select
    (select count(*)::int from inserted) as inserted_count,
    (select count(*)::int from queue_existing) as skipped_queue_count,
    (select count(*)::int from history_existing) as skipped_history_count,
    coalesce((select array_agg(normalized_key) from skipped), array[]::text[]) as skipped_keys;
end;
$$;

grant execute on function public.import_businesses_chunk(uuid, uuid, jsonb) to authenticated;

create or replace function public.archive_empty_businesses(target_workspace uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  affected int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if not public.is_workspace_member(target_workspace) then
    raise exception 'User is not approved for this workspace';
  end if;

  update public.businesses
  set status = 'archived', updated_at = now()
  where workspace_id = target_workspace
    and status in ('pending','scanning','found','ready','review')
    and coalesce(nullif(email, ''), '') = ''
    and coalesce(nullif(website, ''), '') = ''
    and coalesce(nullif(domain, ''), '') = '';

  get diagnostics affected = row_count;
  return affected;
end;
$$;

grant execute on function public.archive_empty_businesses(uuid) to authenticated;


create or replace function public.delete_pending_no_email_businesses(target_workspace uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  affected int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if not public.is_workspace_member(target_workspace) then
    raise exception 'User is not approved for this workspace';
  end if;

  delete from public.businesses
  where workspace_id = target_workspace
    and status in ('pending','scanning','found','review')
    and coalesce(nullif(email, ''), '') = '';

  get diagnostics affected = row_count;
  return affected;
end;
$$;

grant execute on function public.delete_pending_no_email_businesses(uuid) to authenticated;

create or replace function public.mark_ready_emails_and_pending_no_email(target_workspace uuid)
returns table(ready_count int, pending_count int)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if not public.is_workspace_member(target_workspace) then
    raise exception 'User is not approved for this workspace';
  end if;

  -- Recover emails from old imports where the parser stored the raw CSV row but left businesses.email blank.
  update public.businesses
  set
    email = lower((regexp_match(
      concat_ws(' ',
        raw->>'email', raw->>'Email', raw->>'emails', raw->>'Emails',
        raw->>'email1', raw->>'email2', raw->>'email3',
        raw->>'validatedEmail1', raw->>'validatedEmail2', raw->>'validatedEmail3',
        raw->>'business email', raw->>'Business Email', raw->>'personal email', raw->>'Personal Email',
        raw->>'found email', raw->>'Found Email', raw->>'owner email', raw->>'Owner Email'
      ),
      '[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}'
    ))[1]),
    updated_at = now()
  where workspace_id = target_workspace
    and coalesce(nullif(email, ''), '') = ''
    and regexp_match(
      concat_ws(' ',
        raw->>'email', raw->>'Email', raw->>'emails', raw->>'Emails',
        raw->>'email1', raw->>'email2', raw->>'email3',
        raw->>'validatedEmail1', raw->>'validatedEmail2', raw->>'validatedEmail3',
        raw->>'business email', raw->>'Business Email', raw->>'personal email', raw->>'Personal Email',
        raw->>'found email', raw->>'Found Email', raw->>'owner email', raw->>'Owner Email'
      ),
      '[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}'
    ) is not null;

  update public.businesses
  set status = 'ready', score = coalesce(score, 75), updated_at = now()
  where workspace_id = target_workspace
    and coalesce(nullif(email, ''), '') <> ''
    and status in ('pending','found','review');

  update public.businesses
  set status = 'pending', updated_at = now()
  where workspace_id = target_workspace
    and coalesce(nullif(email, ''), '') = ''
    and status in ('found','review','ready');

  return query
  select
    (select count(*)::int from public.businesses where workspace_id = target_workspace and status = 'ready' and coalesce(nullif(email, ''), '') <> '') as ready_count,
    (select count(*)::int from public.businesses where workspace_id = target_workspace and status = 'pending' and coalesce(nullif(email, ''), '') = '') as pending_count;
end;
$$;

grant execute on function public.mark_ready_emails_and_pending_no_email(uuid) to authenticated;


alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.import_batches enable row level security;
alter table public.businesses enable row level security;
alter table public.scout_history enable row level security;
alter table public.email_candidates enable row level security;
alter table public.sent_messages enable row level security;
alter table public.reply_history enable row level security;
alter table public.no_inbox_records enable row level security;
alter table public.templates enable row level security;
alter table public.gmail_accounts enable row level security;
alter table public.activity_logs enable row level security;
alter table public.email_research_jobs enable row level security;

drop policy if exists "profiles read own" on public.profiles;
create policy "profiles read own" on public.profiles for select using (id = auth.uid());

drop policy if exists "workspaces read member" on public.workspaces;
create policy "workspaces read member" on public.workspaces for select using (public.is_workspace_member(id));

drop policy if exists "workspace members read own workspace" on public.workspace_members;
create policy "workspace members read own workspace" on public.workspace_members for select using (public.is_workspace_member(workspace_id));

-- Workspace data policies.
do $$
declare
  t text;
begin
  foreach t in array array['import_batches','businesses','scout_history','email_candidates','sent_messages','reply_history','no_inbox_records','templates','gmail_accounts','activity_logs','email_research_jobs'] loop
    execute format('drop policy if exists %I on public.%I', t || ' select member', t);
    execute format('create policy %I on public.%I for select using (public.is_workspace_member(workspace_id))', t || ' select member', t);
    execute format('drop policy if exists %I on public.%I', t || ' insert member', t);
    execute format('create policy %I on public.%I for insert with check (public.is_workspace_member(workspace_id))', t || ' insert member', t);
    execute format('drop policy if exists %I on public.%I', t || ' update member', t);
    execute format('create policy %I on public.%I for update using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id))', t || ' update member', t);
    execute format('drop policy if exists %I on public.%I', t || ' delete member', t);
    execute format('create policy %I on public.%I for delete using (public.is_workspace_member(workspace_id))', t || ' delete member', t);
  end loop;
end $$;

-- v8.6 Native Outreach Engine additions.
alter table public.templates add column if not exists subject_variants text[] not null default '{}';
alter table public.templates add column if not exists active boolean not null default true;
alter table public.templates add column if not exists updated_at timestamptz not null default now();

drop trigger if exists templates_touch_updated_at on public.templates;
create trigger templates_touch_updated_at before update on public.templates for each row execute function public.touch_updated_at();

alter table public.gmail_accounts add column if not exists access_token text;
alter table public.gmail_accounts add column if not exists refresh_token text;
alter table public.gmail_accounts add column if not exists client_id text;
alter table public.gmail_accounts add column if not exists expires_at timestamptz;
alter table public.gmail_accounts add column if not exists daily_limit int not null default 400;
alter table public.gmail_accounts add column if not exists sent_today int not null default 0;
alter table public.gmail_accounts add column if not exists paused_until timestamptz;
alter table public.gmail_accounts add column if not exists last_error text;
alter table public.gmail_accounts add column if not exists raw jsonb not null default '{}'::jsonb;
alter table public.gmail_accounts add column if not exists updated_at timestamptz not null default now();

drop trigger if exists gmail_accounts_touch_updated_at on public.gmail_accounts;
create trigger gmail_accounts_touch_updated_at before update on public.gmail_accounts for each row execute function public.touch_updated_at();

create index if not exists gmail_accounts_workspace_status_idx on public.gmail_accounts(workspace_id, status, paused_until);

create table if not exists public.outreach_batches (
  id text primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  template_id uuid references public.templates(id) on delete set null,
  requested_count int not null default 0,
  selected_sender_count int not null default 0,
  attempted_count int not null default 0,
  sent_count int not null default 0,
  failed_count int not null default 0,
  skipped_count int not null default 0,
  status text not null default 'running',
  raw jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists outreach_batches_workspace_created_idx on public.outreach_batches(workspace_id, created_at desc);
create index if not exists outreach_batches_workspace_status_idx on public.outreach_batches(workspace_id, status, created_at desc);

drop trigger if exists outreach_batches_touch_updated_at on public.outreach_batches;
create trigger outreach_batches_touch_updated_at before update on public.outreach_batches for each row execute function public.touch_updated_at();

create table if not exists public.outreach_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  batch_id text references public.outreach_batches(id) on delete set null,
  business_id uuid references public.businesses(id) on delete set null,
  template_id uuid references public.templates(id) on delete set null,
  gmail_account_id uuid references public.gmail_accounts(id) on delete set null,
  type text not null default 'info',
  message text,
  raw jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists outreach_events_workspace_batch_idx on public.outreach_events(workspace_id, batch_id, created_at desc);
create index if not exists outreach_events_workspace_type_idx on public.outreach_events(workspace_id, type, created_at desc);

alter table public.sent_messages add column if not exists template_id uuid references public.templates(id) on delete set null;
alter table public.sent_messages add column if not exists gmail_account_id uuid references public.gmail_accounts(id) on delete set null;
alter table public.sent_messages add column if not exists batch_id text references public.outreach_batches(id) on delete set null;
alter table public.sent_messages add column if not exists gmail_thread_id text;
alter table public.sent_messages add column if not exists delivery_status text;
alter table public.sent_messages add column if not exists error_code text;

create index if not exists sent_messages_workspace_template_idx on public.sent_messages(workspace_id, template_id, sent_at desc);
create index if not exists sent_messages_workspace_gmail_idx on public.sent_messages(workspace_id, gmail_account_id, sent_at desc);
create index if not exists sent_messages_workspace_batch_idx on public.sent_messages(workspace_id, batch_id, sent_at desc);

alter table public.reply_history add column if not exists sent_message_id uuid references public.sent_messages(id) on delete set null;
alter table public.reply_history add column if not exists template_id uuid references public.templates(id) on delete set null;
alter table public.reply_history add column if not exists gmail_account_id uuid references public.gmail_accounts(id) on delete set null;
alter table public.reply_history add column if not exists batch_id text references public.outreach_batches(id) on delete set null;

create index if not exists reply_history_workspace_template_idx on public.reply_history(workspace_id, template_id, received_at desc);
create index if not exists reply_history_workspace_gmail_idx on public.reply_history(workspace_id, gmail_account_id, received_at desc);
create index if not exists reply_history_workspace_real_idx on public.reply_history(workspace_id, is_real_reply, received_at desc);

alter table public.outreach_batches enable row level security;
alter table public.outreach_events enable row level security;

drop policy if exists "outreach_batches select member" on public.outreach_batches;
create policy "outreach_batches select member" on public.outreach_batches for select using (public.is_workspace_member(workspace_id));
drop policy if exists "outreach_batches insert member" on public.outreach_batches;
create policy "outreach_batches insert member" on public.outreach_batches for insert with check (public.is_workspace_member(workspace_id));
drop policy if exists "outreach_batches update member" on public.outreach_batches;
create policy "outreach_batches update member" on public.outreach_batches for update using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
drop policy if exists "outreach_batches delete member" on public.outreach_batches;
create policy "outreach_batches delete member" on public.outreach_batches for delete using (public.is_workspace_member(workspace_id));

drop policy if exists "outreach_events select member" on public.outreach_events;
create policy "outreach_events select member" on public.outreach_events for select using (public.is_workspace_member(workspace_id));
drop policy if exists "outreach_events insert member" on public.outreach_events;
create policy "outreach_events insert member" on public.outreach_events for insert with check (public.is_workspace_member(workspace_id));
drop policy if exists "outreach_events update member" on public.outreach_events;
create policy "outreach_events update member" on public.outreach_events for update using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
drop policy if exists "outreach_events delete member" on public.outreach_events;
create policy "outreach_events delete member" on public.outreach_events for delete using (public.is_workspace_member(workspace_id));

create or replace function public.reset_gmail_daily_counts(target_workspace uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  affected int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if not public.is_workspace_member(target_workspace) then
    raise exception 'User is not approved for this workspace';
  end if;

  update public.gmail_accounts
  set sent_today = 0,
      paused_until = null,
      last_error = null,
      status = case when status = 'limit_hit' then 'connected' else status end,
      updated_at = now()
  where workspace_id = target_workspace;

  get diagnostics affected = row_count;
  return affected;
end;
$$;

grant execute on function public.reset_gmail_daily_counts(uuid) to authenticated;

-- v8.7 Reply Tracking + Import Parser Fix support.
alter table public.reply_history add column if not exists gmail_message_id text;
alter table public.reply_history add column if not exists gmail_thread_id text;
alter table public.reply_history add column if not exists direction text not null default 'received';
alter table public.reply_history add column if not exists matched_status text;

create unique index if not exists reply_history_workspace_gmail_message_unique on public.reply_history(workspace_id, gmail_message_id);
create index if not exists reply_history_workspace_thread_idx on public.reply_history(workspace_id, gmail_thread_id, received_at desc);
create index if not exists reply_history_workspace_classification_idx on public.reply_history(workspace_id, classification, received_at desc);

alter table public.no_inbox_records add column if not exists sent_message_id uuid references public.sent_messages(id) on delete set null;
alter table public.no_inbox_records add column if not exists gmail_account_id uuid references public.gmail_accounts(id) on delete set null;
alter table public.no_inbox_records add column if not exists template_id uuid references public.templates(id) on delete set null;
alter table public.no_inbox_records add column if not exists gmail_message_id text;
alter table public.no_inbox_records add column if not exists gmail_thread_id text;

create index if not exists no_inbox_records_workspace_email_idx on public.no_inbox_records(workspace_id, email, created_at desc);
create index if not exists no_inbox_records_workspace_template_idx on public.no_inbox_records(workspace_id, template_id, created_at desc);
create index if not exists no_inbox_records_workspace_gmail_idx on public.no_inbox_records(workspace_id, gmail_account_id, created_at desc);

alter table public.sent_messages add column if not exists last_reply_at timestamptz;

create or replace view public.template_response_performance as
select
  t.workspace_id,
  t.id as template_id,
  t.name as template_name,
  count(distinct s.id) filter (where s.status = 'sent') as sent_count,
  count(distinct r.id) filter (where r.is_real_reply = true) as real_reply_count,
  count(distinct r.id) filter (where r.is_real_reply = false) as ignored_reply_count,
  case when count(distinct r.id) filter (where r.is_real_reply = true) > 0
    then round((count(distinct s.id) filter (where s.status = 'sent'))::numeric / (count(distinct r.id) filter (where r.is_real_reply = true))::numeric, 2)
    else null
  end as emails_per_reply
from public.templates t
left join public.sent_messages s on s.template_id = t.id and s.workspace_id = t.workspace_id
left join public.reply_history r on r.template_id = t.id and r.workspace_id = t.workspace_id
group by t.workspace_id, t.id, t.name;

-- v8.15 Message Library, scheduling, and follow-up support.
create table if not exists public.message_categories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  description text,
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workspace_id, name)
);

create index if not exists message_categories_workspace_name_idx on public.message_categories(workspace_id, name);

alter table public.templates add column if not exists category_id uuid references public.message_categories(id) on delete set null;
alter table public.templates add column if not exists category_name text;
alter table public.templates add column if not exists purpose text;
create index if not exists templates_workspace_category_idx on public.templates(workspace_id, category_id, active, created_at desc);

alter table public.sent_messages add column if not exists is_follow_up boolean not null default false;
alter table public.sent_messages add column if not exists followup_due_at timestamptz;
create index if not exists sent_messages_workspace_followup_idx on public.sent_messages(workspace_id, is_follow_up, sent_at desc);

create table if not exists public.message_schedules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  type text not null default 'initial' check (type in ('initial','follow_up')),
  category_id uuid references public.message_categories(id) on delete set null,
  template_id uuid references public.templates(id) on delete set null,
  target_count int not null default 100,
  scheduled_for timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled','due','running','sent','cancelled','failed')),
  raw jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists message_schedules_workspace_status_idx on public.message_schedules(workspace_id, status, scheduled_for);

drop trigger if exists message_categories_touch_updated_at on public.message_categories;
create trigger message_categories_touch_updated_at before update on public.message_categories for each row execute function public.touch_updated_at();

drop trigger if exists message_schedules_touch_updated_at on public.message_schedules;
create trigger message_schedules_touch_updated_at before update on public.message_schedules for each row execute function public.touch_updated_at();

alter table public.message_categories enable row level security;
alter table public.message_schedules enable row level security;

drop policy if exists "message_categories select member" on public.message_categories;
create policy "message_categories select member" on public.message_categories for select using (public.is_workspace_member(workspace_id));
drop policy if exists "message_categories insert member" on public.message_categories;
create policy "message_categories insert member" on public.message_categories for insert with check (public.is_workspace_member(workspace_id));
drop policy if exists "message_categories update member" on public.message_categories;
create policy "message_categories update member" on public.message_categories for update using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
drop policy if exists "message_categories delete member" on public.message_categories;
create policy "message_categories delete member" on public.message_categories for delete using (public.is_workspace_member(workspace_id));

drop policy if exists "message_schedules select member" on public.message_schedules;
create policy "message_schedules select member" on public.message_schedules for select using (public.is_workspace_member(workspace_id));
drop policy if exists "message_schedules insert member" on public.message_schedules;
create policy "message_schedules insert member" on public.message_schedules for insert with check (public.is_workspace_member(workspace_id));
drop policy if exists "message_schedules update member" on public.message_schedules;
create policy "message_schedules update member" on public.message_schedules for update using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
drop policy if exists "message_schedules delete member" on public.message_schedules;
create policy "message_schedules delete member" on public.message_schedules for delete using (public.is_workspace_member(workspace_id));

insert into public.message_categories (workspace_id, name, description)
values
  ('00000000-0000-4000-8000-000000000001', 'Airtable Google Map scouting', 'Messages for Airtable systems built from Google Maps/directories.'),
  ('00000000-0000-4000-8000-000000000001', 'Airtable Google Doc scouting', 'Messages for Airtable systems built from docs/sheets workflow gaps.'),
  ('00000000-0000-4000-8000-000000000001', 'Shopify design scouting', 'Messages focused on store design, trust, product page, and conversion flow.'),
  ('00000000-0000-4000-8000-000000000001', 'Shopify marketing scouting', 'Messages focused on traffic quality, email capture, abandoned cart, and retention.')
on conflict (workspace_id, name) do nothing;

drop function if exists public.count_due_followups(uuid, text);
drop function if exists public.get_due_followups(uuid, integer, text);
create function public.get_due_followups(
  target_workspace uuid,
  limit_rows int default 100
)
returns table(
  business_id uuid,
  business_name text,
  to_email text,
  last_sent_at timestamptz,
  last_subject text,
  template_id uuid,
  gmail_account_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if not public.is_workspace_member(target_workspace) then
    raise exception 'User is not approved for this workspace';
  end if;

  return query
  with latest_sent as (
    select distinct on (s.business_id)
      s.business_id,
      s.to_email,
      s.sent_at,
      s.subject,
      s.template_id,
      s.gmail_account_id
    from public.sent_messages s
    where s.workspace_id = target_workspace
      and s.status = 'sent'
      and s.sent_at <= now() - interval '72 hours'
      and s.business_id is not null
    order by s.business_id, s.sent_at desc
  )
  select
    b.id as business_id,
    b.name as business_name,
    l.to_email,
    l.sent_at as last_sent_at,
    l.subject as last_subject,
    l.template_id,
    l.gmail_account_id
  from latest_sent l
  join public.businesses b on b.id = l.business_id and b.workspace_id = target_workspace
  where b.status = 'contacted'
    and coalesce(nullif(l.to_email, ''), '') <> ''
    and not exists (
      select 1 from public.reply_history r
      where r.workspace_id = target_workspace
        and r.business_id = b.id
        and r.is_real_reply = true
        and r.received_at >= l.sent_at
    )
    and not exists (
      select 1 from public.no_inbox_records n
      where n.workspace_id = target_workspace
        and (n.business_id = b.id or lower(coalesce(n.email, '')) = lower(l.to_email))
        and n.created_at >= l.sent_at
    )
  order by l.sent_at asc
  limit greatest(1, least(coalesce(limit_rows, 100), 5000));
end;
$$;

grant execute on function public.get_due_followups(uuid, int) to authenticated;

create or replace view public.sender_response_performance as
select
  g.workspace_id,
  g.id as gmail_account_id,
  g.email as sender_email,
  count(distinct s.id) filter (where s.status = 'sent') as sent_count,
  count(distinct r.id) filter (where r.is_real_reply = true) as real_reply_count,
  case when count(distinct r.id) filter (where r.is_real_reply = true) > 0
    then round((count(distinct s.id) filter (where s.status = 'sent'))::numeric / (count(distinct r.id) filter (where r.is_real_reply = true))::numeric, 2)
    else null
  end as emails_per_reply
from public.gmail_accounts g
left join public.sent_messages s on s.gmail_account_id = g.id and s.workspace_id = g.workspace_id
left join public.reply_history r on r.gmail_account_id = g.id and r.workspace_id = g.workspace_id
group by g.workspace_id, g.id, g.email;

-- v8.22 Sender settings limits, seed inbox tests, spam guard support.
alter table public.gmail_accounts add column if not exists account_type text not null default 'gmail';
alter table public.gmail_accounts add column if not exists default_run_limit int not null default 100;
alter table public.gmail_accounts add column if not exists seed_inbox_enabled boolean not null default false;
alter table public.gmail_accounts add column if not exists seed_test_address text;
alter table public.gmail_accounts add column if not exists spam_risk_status text;
alter table public.gmail_accounts add column if not exists last_seed_result text;
alter table public.gmail_accounts add column if not exists last_seed_checked_at timestamptz;

create table if not exists public.seed_inbox_tests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  sender_gmail_account_id uuid references public.gmail_accounts(id) on delete set null,
  seed_gmail_account_id uuid references public.gmail_accounts(id) on delete set null,
  sender_email text,
  seed_email text,
  subject text,
  placement text not null default 'sent_pending_check',
  checked_at timestamptz,
  gmail_message_id text,
  gmail_thread_id text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists seed_inbox_tests_workspace_created_idx on public.seed_inbox_tests(workspace_id, created_at desc);
create index if not exists seed_inbox_tests_sender_idx on public.seed_inbox_tests(workspace_id, sender_gmail_account_id, created_at desc);
create index if not exists gmail_accounts_workspace_seed_idx on public.gmail_accounts(workspace_id, seed_inbox_enabled, spam_risk_status);

alter table public.seed_inbox_tests enable row level security;
drop policy if exists "seed_inbox_tests select member" on public.seed_inbox_tests;
create policy "seed_inbox_tests select member" on public.seed_inbox_tests for select using (public.is_workspace_member(workspace_id));
drop policy if exists "seed_inbox_tests insert member" on public.seed_inbox_tests;
create policy "seed_inbox_tests insert member" on public.seed_inbox_tests for insert with check (public.is_workspace_member(workspace_id));
drop policy if exists "seed_inbox_tests update member" on public.seed_inbox_tests;
create policy "seed_inbox_tests update member" on public.seed_inbox_tests for update using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
drop policy if exists "seed_inbox_tests delete member" on public.seed_inbox_tests;
create policy "seed_inbox_tests delete member" on public.seed_inbox_tests for delete using (public.is_workspace_member(workspace_id));


-- Ensure due follow-ups RPC exists for Message page.
drop function if exists public.count_due_followups(uuid, text);
drop function if exists public.get_due_followups(uuid, integer, text);
create function public.get_due_followups(
  target_workspace uuid,
  limit_rows int default 100
)
returns table(
  business_id uuid,
  business_name text,
  to_email text,
  last_sent_at timestamptz,
  last_subject text,
  template_id uuid,
  gmail_account_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if not public.is_workspace_member(target_workspace) then
    raise exception 'User is not approved for this workspace';
  end if;

  return query
  with latest_sent as (
    select distinct on (s.business_id)
      s.business_id,
      s.to_email,
      s.sent_at,
      s.subject,
      s.template_id,
      s.gmail_account_id
    from public.sent_messages s
    where s.workspace_id = target_workspace
      and s.status = 'sent'
      and s.sent_at <= now() - interval '72 hours'
      and s.business_id is not null
    order by s.business_id, s.sent_at desc
  )
  select
    b.id as business_id,
    b.name as business_name,
    l.to_email,
    l.sent_at as last_sent_at,
    l.subject as last_subject,
    l.template_id,
    l.gmail_account_id
  from latest_sent l
  join public.businesses b on b.id = l.business_id and b.workspace_id = target_workspace
  where b.status = 'contacted'
    and coalesce(nullif(l.to_email, ''), '') <> ''
    and not exists (
      select 1 from public.reply_history r
      where r.workspace_id = target_workspace
        and r.business_id = b.id
        and r.is_real_reply = true
        and r.received_at >= l.sent_at
    )
    and not exists (
      select 1 from public.no_inbox_records n
      where n.workspace_id = target_workspace
        and (n.business_id = b.id or lower(coalesce(n.email, '')) = lower(l.to_email))
        and n.created_at >= l.sent_at
    )
  order by l.sent_at asc
  limit greatest(1, least(coalesce(limit_rows, 100), 5000));
end;
$$;

grant execute on function public.get_due_followups(uuid, int) to authenticated;

select pg_notify('pgrst', 'reload schema');

-- <<< END 202607050001_scout_v8_cloud.sql

-- >>> BEGIN 202607090824_reply_sync_no_inbox.sql
create or replace function public.is_workspace_member(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null;
$$;

grant execute on function public.is_workspace_member(uuid) to authenticated;
grant execute on function public.is_workspace_member(uuid) to anon;

create table if not exists public.sent_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  business_id uuid,
  template_id uuid,
  gmail_account_id uuid,
  batch_id text,
  to_email text,
  from_email text,
  subject text,
  body text,
  provider_message_id text,
  gmail_thread_id text,
  status text not null default 'sent',
  delivery_status text,
  error_code text,
  is_follow_up boolean not null default false,
  followup_due_at timestamptz,
  last_reply_at timestamptz,
  sent_at timestamptz not null default now(),
  raw jsonb not null default '{}'::jsonb
);

alter table public.sent_messages add column if not exists business_id uuid;
alter table public.sent_messages add column if not exists template_id uuid;
alter table public.sent_messages add column if not exists gmail_account_id uuid;
alter table public.sent_messages add column if not exists batch_id text;
alter table public.sent_messages add column if not exists to_email text;
alter table public.sent_messages add column if not exists from_email text;
alter table public.sent_messages add column if not exists subject text;
alter table public.sent_messages add column if not exists body text;
alter table public.sent_messages add column if not exists provider_message_id text;
alter table public.sent_messages add column if not exists gmail_thread_id text;
alter table public.sent_messages add column if not exists status text not null default 'sent';
alter table public.sent_messages add column if not exists delivery_status text;
alter table public.sent_messages add column if not exists error_code text;
alter table public.sent_messages add column if not exists is_follow_up boolean not null default false;
alter table public.sent_messages add column if not exists followup_due_at timestamptz;
alter table public.sent_messages add column if not exists last_reply_at timestamptz;
alter table public.sent_messages add column if not exists sent_at timestamptz not null default now();
alter table public.sent_messages add column if not exists raw jsonb not null default '{}'::jsonb;

create index if not exists sent_messages_workspace_sent_idx on public.sent_messages(workspace_id, sent_at desc);
create index if not exists sent_messages_workspace_thread_idx on public.sent_messages(workspace_id, gmail_thread_id);
create index if not exists sent_messages_workspace_to_email_idx on public.sent_messages(workspace_id, lower(to_email));
create index if not exists sent_messages_workspace_gmail_idx on public.sent_messages(workspace_id, gmail_account_id, sent_at desc);
create index if not exists sent_messages_workspace_template_idx on public.sent_messages(workspace_id, template_id, sent_at desc);

create table if not exists public.reply_history (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  business_id uuid,
  sent_message_id uuid,
  template_id uuid,
  gmail_account_id uuid,
  batch_id text,
  from_email text,
  to_email text,
  subject text,
  snippet text,
  body text,
  classification text,
  is_real_reply boolean not null default false,
  received_at timestamptz not null default now(),
  gmail_message_id text,
  gmail_thread_id text,
  matched_status text,
  raw jsonb not null default '{}'::jsonb
);

alter table public.reply_history add column if not exists sent_message_id uuid;
alter table public.reply_history add column if not exists template_id uuid;
alter table public.reply_history add column if not exists gmail_account_id uuid;
alter table public.reply_history add column if not exists batch_id text;
alter table public.reply_history add column if not exists from_email text;
alter table public.reply_history add column if not exists to_email text;
alter table public.reply_history add column if not exists subject text;
alter table public.reply_history add column if not exists snippet text;
alter table public.reply_history add column if not exists body text;
alter table public.reply_history add column if not exists classification text;
alter table public.reply_history add column if not exists is_real_reply boolean not null default false;
alter table public.reply_history add column if not exists received_at timestamptz not null default now();
alter table public.reply_history add column if not exists gmail_message_id text;
alter table public.reply_history add column if not exists gmail_thread_id text;
alter table public.reply_history add column if not exists matched_status text;
alter table public.reply_history add column if not exists raw jsonb not null default '{}'::jsonb;

create unique index if not exists reply_history_workspace_gmail_message_uid on public.reply_history(workspace_id, gmail_message_id) where gmail_message_id is not null;
create index if not exists reply_history_workspace_real_idx on public.reply_history(workspace_id, is_real_reply, received_at desc);
create index if not exists reply_history_workspace_thread_idx on public.reply_history(workspace_id, gmail_thread_id);

create table if not exists public.no_inbox_records (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  business_id uuid,
  sent_message_id uuid,
  gmail_account_id uuid,
  template_id uuid,
  email text,
  reason text,
  gmail_message_id text,
  gmail_thread_id text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.no_inbox_records add column if not exists sent_message_id uuid;
alter table public.no_inbox_records add column if not exists gmail_account_id uuid;
alter table public.no_inbox_records add column if not exists template_id uuid;
alter table public.no_inbox_records add column if not exists email text;
alter table public.no_inbox_records add column if not exists reason text;
alter table public.no_inbox_records add column if not exists gmail_message_id text;
alter table public.no_inbox_records add column if not exists gmail_thread_id text;
alter table public.no_inbox_records add column if not exists raw jsonb not null default '{}'::jsonb;
alter table public.no_inbox_records add column if not exists created_at timestamptz not null default now();

create unique index if not exists no_inbox_records_workspace_gmail_message_uid on public.no_inbox_records(workspace_id, gmail_message_id) where gmail_message_id is not null;
create index if not exists no_inbox_records_workspace_created_idx on public.no_inbox_records(workspace_id, created_at desc);
create index if not exists no_inbox_records_workspace_email_idx on public.no_inbox_records(workspace_id, lower(email));

alter table public.gmail_accounts add column if not exists access_token text;
alter table public.gmail_accounts add column if not exists refresh_token text;
alter table public.gmail_accounts add column if not exists client_id text;
alter table public.gmail_accounts add column if not exists expires_at timestamptz;
alter table public.gmail_accounts add column if not exists last_error text;
alter table public.gmail_accounts add column if not exists updated_at timestamptz not null default now();

alter table public.sent_messages enable row level security;
alter table public.reply_history enable row level security;
alter table public.no_inbox_records enable row level security;

drop policy if exists sent_messages_member_all on public.sent_messages;
create policy sent_messages_member_all on public.sent_messages for all using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

drop policy if exists reply_history_member_all on public.reply_history;
create policy reply_history_member_all on public.reply_history for all using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

drop policy if exists no_inbox_records_member_all on public.no_inbox_records;
create policy no_inbox_records_member_all on public.no_inbox_records for all using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

select pg_notify('pgrst', 'reload schema');

-- <<< END 202607090824_reply_sync_no_inbox.sql

-- >>> BEGIN 202607090825_reply_intelligence_business_hub.sql
create or replace function public.is_workspace_member(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null;
$$;

grant execute on function public.is_workspace_member(uuid) to authenticated;
grant execute on function public.is_workspace_member(uuid) to anon;

create table if not exists public.gmail_accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  email text not null,
  display_name text,
  status text not null default 'connected',
  access_token text,
  refresh_token text,
  client_id text,
  expires_at timestamptz,
  daily_limit int not null default 400,
  default_run_limit int not null default 100,
  sent_today int not null default 0,
  paused_until timestamptz,
  last_error text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workspace_id, email)
);

create table if not exists public.sent_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  business_id uuid,
  template_id uuid,
  gmail_account_id uuid,
  batch_id text,
  to_email text,
  from_email text,
  subject text,
  body text,
  provider_message_id text,
  gmail_thread_id text,
  status text not null default 'sent',
  delivery_status text,
  error_code text,
  is_follow_up boolean not null default false,
  followup_due_at timestamptz,
  last_reply_at timestamptz,
  sent_at timestamptz not null default now(),
  raw jsonb not null default '{}'::jsonb
);

create table if not exists public.reply_history (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  business_id uuid,
  sent_message_id uuid,
  template_id uuid,
  gmail_account_id uuid,
  batch_id text,
  from_email text,
  to_email text,
  subject text,
  snippet text,
  body text,
  classification text,
  reply_bucket text,
  is_real_reply boolean not null default false,
  is_auto_reply boolean not null default false,
  is_delivery_failure boolean not null default false,
  is_blocked boolean not null default false,
  is_limit_notice boolean not null default false,
  is_temporary boolean not null default false,
  received_at timestamptz not null default now(),
  gmail_message_id text,
  gmail_thread_id text,
  matched_status text,
  raw jsonb not null default '{}'::jsonb
);

create table if not exists public.no_inbox_records (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  business_id uuid,
  sent_message_id uuid,
  gmail_account_id uuid,
  template_id uuid,
  email text,
  to_email text,
  from_email text,
  reason text not null default 'no_inbox',
  status text not null default 'no_inbox',
  type text,
  source text,
  error_code text,
  bounce_type text,
  provider_message_id text,
  gmail_message_id text,
  gmail_thread_id text,
  subject text,
  snippet text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.businesses add column if not exists reply_state text;
alter table public.businesses add column if not exists last_reply_classification text;
alter table public.businesses add column if not exists last_inbound_at timestamptz;
alter table public.businesses add column if not exists last_auto_reply_at timestamptz;
alter table public.businesses add column if not exists last_real_reply_at timestamptz;
alter table public.businesses add column if not exists last_manual_reply_at timestamptz;
alter table public.businesses add column if not exists social_links jsonb not null default '[]'::jsonb;

alter table public.reply_history add column if not exists reply_bucket text;
alter table public.reply_history add column if not exists is_auto_reply boolean not null default false;
alter table public.reply_history add column if not exists is_delivery_failure boolean not null default false;
alter table public.reply_history add column if not exists is_blocked boolean not null default false;
alter table public.reply_history add column if not exists is_limit_notice boolean not null default false;
alter table public.reply_history add column if not exists is_temporary boolean not null default false;
alter table public.reply_history add column if not exists matched_status text;

alter table public.no_inbox_records add column if not exists to_email text;
alter table public.no_inbox_records add column if not exists from_email text;
alter table public.no_inbox_records add column if not exists status text not null default 'no_inbox';
alter table public.no_inbox_records add column if not exists type text;
alter table public.no_inbox_records add column if not exists source text;
alter table public.no_inbox_records add column if not exists error_code text;
alter table public.no_inbox_records add column if not exists bounce_type text;
alter table public.no_inbox_records add column if not exists provider_message_id text;
alter table public.no_inbox_records add column if not exists subject text;
alter table public.no_inbox_records add column if not exists snippet text;
alter table public.no_inbox_records add column if not exists updated_at timestamptz not null default now();

alter table public.sent_messages add column if not exists last_reply_at timestamptz;
alter table public.sent_messages add column if not exists is_follow_up boolean not null default false;

create index if not exists businesses_workspace_reply_state_idx on public.businesses(workspace_id, reply_state, updated_at desc);
create index if not exists reply_history_workspace_bucket_idx on public.reply_history(workspace_id, reply_bucket, received_at desc);
create index if not exists reply_history_workspace_auto_idx on public.reply_history(workspace_id, is_auto_reply, received_at desc);
create index if not exists reply_history_workspace_delivery_idx on public.reply_history(workspace_id, is_delivery_failure, received_at desc);
create index if not exists reply_history_workspace_limit_idx on public.reply_history(workspace_id, is_limit_notice, received_at desc);
create index if not exists reply_history_workspace_business_idx on public.reply_history(workspace_id, business_id, received_at desc);
create unique index if not exists reply_history_workspace_gmail_message_uid on public.reply_history(workspace_id, gmail_message_id) where gmail_message_id is not null;
create index if not exists sent_messages_workspace_business_idx on public.sent_messages(workspace_id, business_id, sent_at desc);
create index if not exists sent_messages_workspace_thread_idx on public.sent_messages(workspace_id, gmail_thread_id);
create index if not exists no_inbox_records_workspace_business_idx on public.no_inbox_records(workspace_id, business_id, created_at desc);
create unique index if not exists no_inbox_records_workspace_gmail_message_uid on public.no_inbox_records(workspace_id, gmail_message_id) where gmail_message_id is not null;

alter table public.gmail_accounts enable row level security;
alter table public.sent_messages enable row level security;
alter table public.reply_history enable row level security;
alter table public.no_inbox_records enable row level security;

drop policy if exists gmail_accounts_member_all on public.gmail_accounts;
create policy gmail_accounts_member_all on public.gmail_accounts for all using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

drop policy if exists sent_messages_member_all on public.sent_messages;
create policy sent_messages_member_all on public.sent_messages for all using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

drop policy if exists reply_history_member_all on public.reply_history;
create policy reply_history_member_all on public.reply_history for all using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

drop policy if exists no_inbox_records_member_all on public.no_inbox_records;
create policy no_inbox_records_member_all on public.no_inbox_records for all using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

select pg_notify('pgrst', 'reload schema');

-- <<< END 202607090825_reply_intelligence_business_hub.sql

-- >>> BEGIN 202607090825_scheduled_sending_worker.sql
create or replace function public.is_workspace_member(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null;
$$;

grant execute on function public.is_workspace_member(uuid) to authenticated;
grant execute on function public.is_workspace_member(uuid) to anon;

create table if not exists public.message_schedules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  type text not null default 'initial',
  category_id uuid,
  template_id uuid,
  target_count int not null default 100,
  scheduled_for timestamptz not null,
  status text not null default 'scheduled',
  raw jsonb not null default '{}'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.message_schedules add column if not exists batch_id text;
alter table public.message_schedules add column if not exists processed_count int not null default 0;
alter table public.message_schedules add column if not exists sent_count int not null default 0;
alter table public.message_schedules add column if not exists failed_count int not null default 0;
alter table public.message_schedules add column if not exists skipped_count int not null default 0;
alter table public.message_schedules add column if not exists started_at timestamptz;
alter table public.message_schedules add column if not exists finished_at timestamptz;
alter table public.message_schedules add column if not exists last_error text;
alter table public.message_schedules add column if not exists updated_at timestamptz not null default now();
alter table public.message_schedules add column if not exists raw jsonb not null default '{}'::jsonb;

create index if not exists message_schedules_workspace_status_due_idx
on public.message_schedules(workspace_id, status, scheduled_for);

create table if not exists public.sent_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  business_id uuid,
  template_id uuid,
  gmail_account_id uuid,
  batch_id text,
  to_email text,
  from_email text,
  subject text,
  body text,
  provider_message_id text,
  gmail_thread_id text,
  status text not null default 'sent',
  delivery_status text,
  error_code text,
  is_follow_up boolean not null default false,
  followup_due_at timestamptz,
  last_reply_at timestamptz,
  sent_at timestamptz not null default now(),
  raw jsonb not null default '{}'::jsonb
);

create table if not exists public.outreach_batches (
  id text primary key,
  workspace_id uuid not null,
  template_id uuid,
  requested_count int not null default 0,
  selected_sender_count int not null default 0,
  attempted_count int not null default 0,
  sent_count int not null default 0,
  failed_count int not null default 0,
  skipped_count int not null default 0,
  status text not null default 'running',
  raw jsonb not null default '{}'::jsonb,
  created_by uuid,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.outreach_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  batch_id text,
  business_id uuid,
  template_id uuid,
  gmail_account_id uuid,
  type text not null default 'info',
  message text,
  raw jsonb not null default '{}'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists sent_messages_workspace_sent_idx
on public.sent_messages(workspace_id, sent_at desc);

create index if not exists sent_messages_workspace_business_idx
on public.sent_messages(workspace_id, business_id, sent_at desc);

create index if not exists outreach_batches_workspace_created_idx
on public.outreach_batches(workspace_id, created_at desc);

create index if not exists outreach_events_workspace_batch_idx
on public.outreach_events(workspace_id, batch_id, created_at desc);

alter table public.message_schedules enable row level security;
alter table public.sent_messages enable row level security;
alter table public.outreach_batches enable row level security;
alter table public.outreach_events enable row level security;

drop policy if exists message_schedules_member_all on public.message_schedules;
create policy message_schedules_member_all
on public.message_schedules
for all
using (public.is_workspace_member(workspace_id))
with check (public.is_workspace_member(workspace_id));

drop policy if exists sent_messages_member_all on public.sent_messages;
create policy sent_messages_member_all
on public.sent_messages
for all
using (public.is_workspace_member(workspace_id))
with check (public.is_workspace_member(workspace_id));

drop policy if exists outreach_batches_member_all on public.outreach_batches;
create policy outreach_batches_member_all
on public.outreach_batches
for all
using (public.is_workspace_member(workspace_id))
with check (public.is_workspace_member(workspace_id));

drop policy if exists outreach_events_member_all on public.outreach_events;
create policy outreach_events_member_all
on public.outreach_events
for all
using (public.is_workspace_member(workspace_id))
with check (public.is_workspace_member(workspace_id));

select pg_notify('pgrst', 'reload schema');

-- <<< END 202607090825_scheduled_sending_worker.sql

-- >>> BEGIN 202607090825_seed_no_inbox_cleanup.sql

-- v8.24.1 cleanup: prevent own connected Gmail accounts from appearing as No Inbox prospects.
-- Run after v8.24/v8.24.1 deploy if your No Inbox page shows your own sender/seed Gmail.

create table if not exists public.no_inbox_records (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  business_id uuid,
  sent_message_id uuid,
  gmail_account_id uuid,
  template_id uuid,
  email text,
  reason text,
  gmail_message_id text,
  gmail_thread_id text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Remove false No Inbox rows where the failed email is one of your connected Gmail accounts.
delete from public.no_inbox_records n
using public.gmail_accounts g
where n.workspace_id = g.workspace_id
  and lower(coalesce(n.email, '')) = lower(coalesce(g.email, ''));

-- Deduplicate repeated Gmail delivery notices.
with ranked as (
  select
    ctid,
    row_number() over (
      partition by workspace_id, gmail_message_id
      order by created_at desc
    ) as rn
  from public.no_inbox_records
  where coalesce(gmail_message_id, '') <> ''
)
delete from public.no_inbox_records n
using ranked r
where n.ctid = r.ctid
  and r.rn > 1;

create unique index if not exists no_inbox_records_workspace_gmail_message_uid
on public.no_inbox_records(workspace_id, gmail_message_id)
where gmail_message_id is not null;

select pg_notify('pgrst', 'reload schema');

-- <<< END 202607090825_seed_no_inbox_cleanup.sql

-- >>> BEGIN 202607090826_scheduled_worker_seed_solid.sql
create or replace function public.is_workspace_member(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null;
$$;

grant execute on function public.is_workspace_member(uuid) to authenticated;
grant execute on function public.is_workspace_member(uuid) to anon;

create table if not exists public.gmail_accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  email text not null,
  display_name text,
  status text not null default 'connected',
  backend_ref text,
  access_token text,
  refresh_token text,
  client_id text,
  expires_at timestamptz,
  daily_limit int not null default 400,
  sent_today int not null default 0,
  paused_until timestamptz,
  last_error text,
  account_type text not null default 'gmail',
  default_run_limit int not null default 100,
  seed_inbox_enabled boolean not null default false,
  seed_test_address text,
  spam_risk_status text,
  last_seed_result text,
  last_seed_checked_at timestamptz,
  raw jsonb not null default '{}'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, email)
);

alter table public.gmail_accounts add column if not exists account_type text not null default 'gmail';
alter table public.gmail_accounts add column if not exists default_run_limit int not null default 100;
alter table public.gmail_accounts add column if not exists seed_inbox_enabled boolean not null default false;
alter table public.gmail_accounts add column if not exists seed_test_address text;
alter table public.gmail_accounts add column if not exists spam_risk_status text;
alter table public.gmail_accounts add column if not exists last_seed_result text;
alter table public.gmail_accounts add column if not exists last_seed_checked_at timestamptz;
alter table public.gmail_accounts add column if not exists sent_today int not null default 0;
alter table public.gmail_accounts add column if not exists daily_limit int not null default 400;
alter table public.gmail_accounts add column if not exists paused_until timestamptz;
alter table public.gmail_accounts add column if not exists last_error text;
alter table public.gmail_accounts add column if not exists access_token text;
alter table public.gmail_accounts add column if not exists refresh_token text;
alter table public.gmail_accounts add column if not exists expires_at timestamptz;
alter table public.gmail_accounts add column if not exists raw jsonb not null default '{}'::jsonb;
alter table public.gmail_accounts add column if not exists updated_at timestamptz not null default now();

create index if not exists gmail_accounts_workspace_seed_idx
on public.gmail_accounts(workspace_id, seed_inbox_enabled, spam_risk_status);

create table if not exists public.seed_inbox_tests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  sender_gmail_account_id uuid,
  seed_gmail_account_id uuid,
  sender_email text,
  seed_email text,
  subject text,
  placement text not null default 'sent_pending_check',
  checked_at timestamptz,
  gmail_message_id text,
  gmail_thread_id text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists seed_inbox_tests_workspace_created_idx
on public.seed_inbox_tests(workspace_id, created_at desc);

create index if not exists seed_inbox_tests_sender_idx
on public.seed_inbox_tests(workspace_id, sender_gmail_account_id, created_at desc);

create table if not exists public.message_schedules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  type text not null default 'initial',
  category_id uuid,
  template_id uuid,
  target_count int not null default 100,
  scheduled_for timestamptz not null,
  status text not null default 'scheduled',
  raw jsonb not null default '{}'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.message_schedules add column if not exists batch_id text;
alter table public.message_schedules add column if not exists processed_count int not null default 0;
alter table public.message_schedules add column if not exists sent_count int not null default 0;
alter table public.message_schedules add column if not exists failed_count int not null default 0;
alter table public.message_schedules add column if not exists skipped_count int not null default 0;
alter table public.message_schedules add column if not exists started_at timestamptz;
alter table public.message_schedules add column if not exists finished_at timestamptz;
alter table public.message_schedules add column if not exists last_error text;
alter table public.message_schedules add column if not exists raw jsonb not null default '{}'::jsonb;
alter table public.message_schedules add column if not exists updated_at timestamptz not null default now();

create index if not exists message_schedules_workspace_status_due_idx
on public.message_schedules(workspace_id, status, scheduled_for);

create table if not exists public.sent_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  business_id uuid,
  template_id uuid,
  gmail_account_id uuid,
  batch_id text,
  to_email text,
  from_email text,
  subject text,
  body text,
  provider_message_id text,
  gmail_thread_id text,
  status text not null default 'sent',
  delivery_status text,
  error_code text,
  is_follow_up boolean not null default false,
  followup_due_at timestamptz,
  last_reply_at timestamptz,
  sent_at timestamptz not null default now(),
  raw jsonb not null default '{}'::jsonb
);

alter table public.sent_messages add column if not exists delivery_status text;
alter table public.sent_messages add column if not exists error_code text;
alter table public.sent_messages add column if not exists is_follow_up boolean not null default false;
alter table public.sent_messages add column if not exists followup_due_at timestamptz;
alter table public.sent_messages add column if not exists last_reply_at timestamptz;
alter table public.sent_messages add column if not exists raw jsonb not null default '{}'::jsonb;

create table if not exists public.outreach_batches (
  id text primary key,
  workspace_id uuid not null,
  template_id uuid,
  requested_count int not null default 0,
  selected_sender_count int not null default 0,
  attempted_count int not null default 0,
  sent_count int not null default 0,
  failed_count int not null default 0,
  skipped_count int not null default 0,
  status text not null default 'running',
  raw jsonb not null default '{}'::jsonb,
  created_by uuid,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.outreach_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  batch_id text,
  business_id uuid,
  template_id uuid,
  gmail_account_id uuid,
  type text not null default 'info',
  message text,
  raw jsonb not null default '{}'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.no_inbox_records (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  business_id uuid,
  sent_message_id uuid,
  gmail_account_id uuid,
  template_id uuid,
  email text,
  to_email text,
  from_email text,
  reason text not null default 'no_inbox',
  status text not null default 'no_inbox',
  type text,
  source text,
  error_code text,
  bounce_type text,
  provider_message_id text,
  gmail_message_id text,
  gmail_thread_id text,
  subject text,
  snippet text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sent_messages_workspace_sent_idx
on public.sent_messages(workspace_id, sent_at desc);
create index if not exists sent_messages_workspace_business_idx
on public.sent_messages(workspace_id, business_id, sent_at desc);
create index if not exists outreach_batches_workspace_created_idx
on public.outreach_batches(workspace_id, created_at desc);
create index if not exists outreach_events_workspace_batch_idx
on public.outreach_events(workspace_id, batch_id, created_at desc);
create index if not exists no_inbox_records_workspace_email_idx
on public.no_inbox_records(workspace_id, lower(coalesce(email, to_email, '')));

alter table public.gmail_accounts enable row level security;
alter table public.seed_inbox_tests enable row level security;
alter table public.message_schedules enable row level security;
alter table public.sent_messages enable row level security;
alter table public.outreach_batches enable row level security;
alter table public.outreach_events enable row level security;
alter table public.no_inbox_records enable row level security;

drop policy if exists gmail_accounts_member_all on public.gmail_accounts;
create policy gmail_accounts_member_all on public.gmail_accounts for all using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
drop policy if exists seed_inbox_tests_member_all on public.seed_inbox_tests;
create policy seed_inbox_tests_member_all on public.seed_inbox_tests for all using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
drop policy if exists message_schedules_member_all on public.message_schedules;
create policy message_schedules_member_all on public.message_schedules for all using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
drop policy if exists sent_messages_member_all on public.sent_messages;
create policy sent_messages_member_all on public.sent_messages for all using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
drop policy if exists outreach_batches_member_all on public.outreach_batches;
create policy outreach_batches_member_all on public.outreach_batches for all using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
drop policy if exists outreach_events_member_all on public.outreach_events;
create policy outreach_events_member_all on public.outreach_events for all using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
drop policy if exists no_inbox_records_member_all on public.no_inbox_records;
create policy no_inbox_records_member_all on public.no_inbox_records for all using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

drop function if exists public.count_due_followups(uuid, text);
drop function if exists public.get_due_followups(uuid, integer, text);
create function public.get_due_followups(
  target_workspace uuid,
  limit_rows int default 100
)
returns table(
  business_id uuid,
  business_name text,
  to_email text,
  last_sent_at timestamptz,
  last_subject text,
  template_id uuid,
  gmail_account_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with latest_sent as (
    select distinct on (s.business_id)
      s.business_id,
      s.to_email,
      s.sent_at,
      s.subject,
      s.template_id,
      s.gmail_account_id
    from public.sent_messages s
    where s.workspace_id = target_workspace
      and s.status = 'sent'
      and coalesce(s.is_follow_up, false) = false
      and s.sent_at <= now() - interval '72 hours'
      and s.business_id is not null
    order by s.business_id, s.sent_at desc
  )
  select
    b.id as business_id,
    b.name as business_name,
    l.to_email,
    l.sent_at as last_sent_at,
    l.subject as last_subject,
    l.template_id,
    l.gmail_account_id
  from latest_sent l
  join public.businesses b on b.id = l.business_id and b.workspace_id = target_workspace
  where b.status = 'contacted'
    and coalesce(nullif(l.to_email, ''), '') <> ''
    and not exists (
      select 1 from public.reply_history r
      where r.workspace_id = target_workspace
        and r.business_id = b.id
        and coalesce(r.is_real_reply, false) = true
        and r.received_at >= l.sent_at
    )
    and not exists (
      select 1 from public.no_inbox_records n
      where n.workspace_id = target_workspace
        and (n.business_id = b.id or lower(coalesce(n.email, n.to_email, '')) = lower(l.to_email))
        and n.created_at >= l.sent_at
    )
  order by l.sent_at asc
  limit greatest(1, least(coalesce(limit_rows, 100), 5000));
end;
$$;

grant execute on function public.get_due_followups(uuid, int) to authenticated;

select pg_notify('pgrst', 'reload schema');

-- <<< END 202607090826_scheduled_worker_seed_solid.sql

-- >>> BEGIN 202607090827_auto_source_scout.sql
-- v8.27 uses existing businesses, email_candidates, import_batches, activity_logs, and email_research_jobs tables.
-- No new schema is required. This only reloads PostgREST schema cache after deployment.
select pg_notify('pgrst', 'reload schema');

-- <<< END 202607090827_auto_source_scout.sql

-- >>> BEGIN 202607090828_deliverability_autoscout_worker.sql
-- v8.28 deliverability + Auto Scout worker support
-- No destructive changes. This makes sure the worker/dashboard tables and indexes exist.

create or replace function public.is_workspace_member(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null;
$$;

grant execute on function public.is_workspace_member(uuid) to authenticated;
grant execute on function public.is_workspace_member(uuid) to anon;

create table if not exists public.email_research_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  business_id uuid not null,
  status text not null default 'queued',
  priority int not null default 100,
  attempts int not null default 0,
  last_error text,
  result jsonb,
  requested_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  unique(workspace_id, business_id)
);

alter table public.email_research_jobs add column if not exists priority int not null default 100;
alter table public.email_research_jobs add column if not exists attempts int not null default 0;
alter table public.email_research_jobs add column if not exists last_error text;
alter table public.email_research_jobs add column if not exists result jsonb;
alter table public.email_research_jobs add column if not exists requested_by uuid;
alter table public.email_research_jobs add column if not exists updated_at timestamptz not null default now();
alter table public.email_research_jobs add column if not exists started_at timestamptz;
alter table public.email_research_jobs add column if not exists finished_at timestamptz;

create index if not exists email_research_jobs_workspace_status_idx
on public.email_research_jobs(workspace_id, status, priority desc, created_at asc);

create index if not exists email_research_jobs_stale_running_idx
on public.email_research_jobs(status, updated_at)
where status = 'running';

create table if not exists public.seed_inbox_tests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  sender_gmail_account_id uuid,
  seed_gmail_account_id uuid,
  sender_email text,
  seed_email text,
  subject text,
  placement text not null default 'sent_pending_check',
  checked_at timestamptz,
  gmail_message_id text,
  gmail_thread_id text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists seed_inbox_tests_workspace_created_idx
on public.seed_inbox_tests(workspace_id, created_at desc);

create index if not exists seed_inbox_tests_sender_idx
on public.seed_inbox_tests(workspace_id, sender_gmail_account_id, created_at desc);

do $$
begin
  if to_regclass('public.sent_messages') is not null then
    create index if not exists sent_messages_workspace_sender_time_idx
    on public.sent_messages(workspace_id, from_email, sent_at desc);
  end if;

  if to_regclass('public.reply_history') is not null then
    create index if not exists reply_history_workspace_received_idx
    on public.reply_history(workspace_id, received_at desc);
  end if;

  if to_regclass('public.no_inbox_records') is not null then
    create index if not exists no_inbox_records_workspace_from_created_idx
    on public.no_inbox_records(workspace_id, from_email, created_at desc);
  end if;
end $$;

alter table public.email_research_jobs enable row level security;
alter table public.seed_inbox_tests enable row level security;

drop policy if exists email_research_jobs_member_all on public.email_research_jobs;
create policy email_research_jobs_member_all
on public.email_research_jobs
for all
using (public.is_workspace_member(workspace_id))
with check (public.is_workspace_member(workspace_id));

drop policy if exists seed_inbox_tests_member_all on public.seed_inbox_tests;
create policy seed_inbox_tests_member_all
on public.seed_inbox_tests
for all
using (public.is_workspace_member(workspace_id))
with check (public.is_workspace_member(workspace_id));

select pg_notify('pgrst', 'reload schema');

-- <<< END 202607090828_deliverability_autoscout_worker.sql

-- >>> BEGIN 202607090829_reply_templates_followup_segments.sql
create or replace function public.is_workspace_member(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null;
$$;

grant execute on function public.is_workspace_member(uuid) to authenticated;
grant execute on function public.is_workspace_member(uuid) to anon;

create table if not exists public.templates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  name text not null,
  subject text not null default '',
  message text not null default '',
  created_by uuid,
  created_at timestamptz not null default now()
);

alter table public.templates add column if not exists subject_variants text[] not null default '{}';
alter table public.templates add column if not exists active boolean not null default true;
alter table public.templates add column if not exists category_id uuid;
alter table public.templates add column if not exists category_name text;
alter table public.templates add column if not exists template_type text not null default 'initial';
alter table public.templates add column if not exists purpose text;
alter table public.templates add column if not exists reply_context text;
alter table public.templates add column if not exists tags text[] not null default '{}';
alter table public.templates add column if not exists updated_at timestamptz not null default now();

update public.templates
set template_type = 'initial'
where template_type is null or template_type = '';

alter table public.templates drop constraint if exists templates_template_type_check;
alter table public.templates add constraint templates_template_type_check
check (template_type in ('initial', 'follow_up', 'reply'));

create index if not exists templates_workspace_type_idx
on public.templates(workspace_id, template_type, active, created_at desc);

create table if not exists public.message_schedules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  type text not null default 'initial',
  category_id uuid,
  template_id uuid,
  target_count int not null default 100,
  scheduled_for timestamptz not null,
  status text not null default 'scheduled',
  raw jsonb not null default '{}'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.message_schedules add column if not exists followup_segment text;
alter table public.message_schedules add column if not exists started_at timestamptz;
alter table public.message_schedules add column if not exists finished_at timestamptz;
alter table public.message_schedules add column if not exists batch_id text;
alter table public.message_schedules add column if not exists processed_count int not null default 0;
alter table public.message_schedules add column if not exists sent_count int not null default 0;
alter table public.message_schedules add column if not exists failed_count int not null default 0;
alter table public.message_schedules add column if not exists skipped_count int not null default 0;
alter table public.message_schedules add column if not exists last_error text;

alter table public.message_schedules drop constraint if exists message_schedules_followup_segment_check;
alter table public.message_schedules add constraint message_schedules_followup_segment_check
check (followup_segment is null or followup_segment in ('all_unanswered', 'no_reply', 'auto_reply'));

create table if not exists public.sent_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  business_id uuid,
  template_id uuid,
  gmail_account_id uuid,
  batch_id text,
  to_email text,
  from_email text,
  subject text,
  body text,
  provider_message_id text,
  gmail_thread_id text,
  status text not null default 'sent',
  delivery_status text,
  error_code text,
  is_follow_up boolean not null default false,
  followup_due_at timestamptz,
  last_reply_at timestamptz,
  sent_at timestamptz not null default now(),
  raw jsonb not null default '{}'::jsonb
);

alter table public.sent_messages add column if not exists template_id uuid;
alter table public.sent_messages add column if not exists is_follow_up boolean not null default false;
alter table public.sent_messages add column if not exists followup_due_at timestamptz;
alter table public.sent_messages add column if not exists last_reply_at timestamptz;
alter table public.sent_messages add column if not exists delivery_status text;
alter table public.sent_messages add column if not exists error_code text;
alter table public.sent_messages add column if not exists raw jsonb not null default '{}'::jsonb;

create table if not exists public.reply_history (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  business_id uuid,
  sent_message_id uuid,
  template_id uuid,
  gmail_account_id uuid,
  batch_id text,
  from_email text,
  to_email text,
  subject text,
  snippet text,
  body text,
  classification text,
  reply_bucket text,
  is_real_reply boolean not null default false,
  is_auto_reply boolean not null default false,
  is_delivery_failure boolean not null default false,
  is_blocked boolean not null default false,
  is_limit_notice boolean not null default false,
  is_temporary boolean not null default false,
  matched_status text,
  received_at timestamptz not null default now(),
  gmail_message_id text,
  gmail_thread_id text,
  raw jsonb not null default '{}'::jsonb
);

alter table public.reply_history add column if not exists reply_bucket text;
alter table public.reply_history add column if not exists is_real_reply boolean not null default false;
alter table public.reply_history add column if not exists is_auto_reply boolean not null default false;
alter table public.reply_history add column if not exists is_delivery_failure boolean not null default false;
alter table public.reply_history add column if not exists is_blocked boolean not null default false;
alter table public.reply_history add column if not exists is_limit_notice boolean not null default false;
alter table public.reply_history add column if not exists is_temporary boolean not null default false;
alter table public.reply_history add column if not exists matched_status text;
alter table public.reply_history add column if not exists received_at timestamptz not null default now();
alter table public.reply_history add column if not exists raw jsonb not null default '{}'::jsonb;

create table if not exists public.no_inbox_records (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  business_id uuid,
  sent_message_id uuid,
  gmail_account_id uuid,
  template_id uuid,
  email text,
  to_email text,
  from_email text,
  reason text not null default 'no_inbox',
  status text not null default 'no_inbox',
  type text,
  source text,
  error_code text,
  bounce_type text,
  provider_message_id text,
  gmail_message_id text,
  gmail_thread_id text,
  subject text,
  snippet text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.businesses add column if not exists reply_state text;
alter table public.businesses add column if not exists last_reply_classification text;
alter table public.businesses add column if not exists last_inbound_at timestamptz;
alter table public.businesses add column if not exists last_auto_reply_at timestamptz;
alter table public.businesses add column if not exists last_real_reply_at timestamptz;
alter table public.businesses add column if not exists last_manual_reply_at timestamptz;

create index if not exists reply_history_workspace_business_bucket_idx
on public.reply_history(workspace_id, business_id, reply_bucket, received_at desc);

create index if not exists sent_messages_workspace_business_sent_idx
on public.sent_messages(workspace_id, business_id, sent_at desc);

create index if not exists no_inbox_records_workspace_business_idx
on public.no_inbox_records(workspace_id, business_id, created_at desc);

-- Safe re-run: PostgreSQL cannot change a table-returning function's output columns in place.
drop function if exists public.get_due_followups(uuid, integer, text);

drop function if exists public.count_due_followups(uuid, text);
drop function if exists public.get_due_followups(uuid, integer, text);
create function public.get_due_followups(
  target_workspace uuid,
  limit_rows int default 100,
  followup_segment text default 'all_unanswered'
)
returns table(
  business_id uuid,
  business_name text,
  to_email text,
  last_sent_at timestamptz,
  last_subject text,
  template_id uuid,
  gmail_account_id uuid,
  segment text,
  reply_state text,
  last_auto_reply_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if not public.is_workspace_member(target_workspace) then
    raise exception 'User is not approved for this workspace';
  end if;

  return query
  with latest_sent as (
    select distinct on (s.business_id)
      s.business_id,
      s.to_email,
      s.sent_at,
      s.subject,
      s.template_id,
      s.gmail_account_id
    from public.sent_messages s
    where s.workspace_id = target_workspace
      and s.status = 'sent'
      and s.sent_at <= now() - interval '72 hours'
      and s.business_id is not null
      and coalesce(s.delivery_status, '') <> 'manual_reply_sent'
    order by s.business_id, s.sent_at desc
  ), classified as (
    select
      b.id as business_id,
      b.name as business_name,
      coalesce(nullif(l.to_email, ''), b.email) as to_email,
      l.sent_at as last_sent_at,
      l.subject as last_subject,
      l.template_id,
      l.gmail_account_id,
      b.reply_state,
      b.last_auto_reply_at,
      exists (
        select 1 from public.reply_history r
        where r.workspace_id = target_workspace
          and r.business_id = b.id
          and (coalesce(r.is_real_reply, false) = true or r.reply_bucket = 'real_reply')
          and r.received_at >= l.sent_at
      ) as has_real_reply,
      exists (
        select 1 from public.reply_history r
        where r.workspace_id = target_workspace
          and r.business_id = b.id
          and (coalesce(r.is_auto_reply, false) = true or r.reply_bucket = 'auto_reply')
          and r.received_at >= l.sent_at
      ) as has_auto_reply,
      exists (
        select 1 from public.reply_history r
        where r.workspace_id = target_workspace
          and r.business_id = b.id
          and (coalesce(r.is_real_reply, false) = true or coalesce(r.is_auto_reply, false) = true or r.reply_bucket in ('real_reply', 'auto_reply'))
          and r.received_at >= l.sent_at
      ) as has_any_reply,
      exists (
        select 1 from public.no_inbox_records n
        where n.workspace_id = target_workspace
          and (n.business_id = b.id or lower(coalesce(n.email, n.to_email, '')) = lower(coalesce(l.to_email, b.email, '')))
          and n.created_at >= l.sent_at
      ) as has_delivery_failure
    from latest_sent l
    join public.businesses b on b.id = l.business_id and b.workspace_id = target_workspace
    where b.status in ('contacted', 'ready', 'found', 'review')
      and coalesce(nullif(l.to_email, ''), b.email, '') <> ''
  )
  select
    c.business_id,
    c.business_name,
    c.to_email,
    c.last_sent_at,
    c.last_subject,
    c.template_id,
    c.gmail_account_id,
    case when c.has_auto_reply then 'auto_reply' else 'no_reply' end as segment,
    c.reply_state,
    c.last_auto_reply_at
  from classified c
  where c.has_real_reply = false
    and c.has_delivery_failure = false
    and (
      coalesce(followup_segment, 'all_unanswered') = 'all_unanswered'
      or (followup_segment = 'no_reply' and c.has_any_reply = false)
      or (followup_segment = 'auto_reply' and c.has_auto_reply = true)
    )
  order by c.last_sent_at asc
  limit greatest(1, least(coalesce(limit_rows, 100), 5000));
end;
$$;

grant execute on function public.get_due_followups(uuid, int, text) to authenticated;

alter table public.templates enable row level security;
alter table public.message_schedules enable row level security;
alter table public.sent_messages enable row level security;
alter table public.reply_history enable row level security;
alter table public.no_inbox_records enable row level security;

drop policy if exists templates_member_all on public.templates;
create policy templates_member_all on public.templates for all using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

drop policy if exists message_schedules_member_all on public.message_schedules;
create policy message_schedules_member_all on public.message_schedules for all using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

drop policy if exists sent_messages_member_all on public.sent_messages;
create policy sent_messages_member_all on public.sent_messages for all using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

drop policy if exists reply_history_member_all on public.reply_history;
create policy reply_history_member_all on public.reply_history for all using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

drop policy if exists no_inbox_records_member_all on public.no_inbox_records;
create policy no_inbox_records_member_all on public.no_inbox_records for all using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

insert into public.templates (workspace_id, name, category_name, template_type, subject, subject_variants, message, purpose, active)
values
('00000000-0000-4000-8000-000000000001', 'Default follow-up: no reply', 'General follow-ups', 'follow_up', 'Re: quick idea for {business}', array['Following up on {business}'], 'Hi {name},\n\nJust following up on my earlier message about {business}.\n\nWould it be useful if I sent the 2-3 practical improvements I noticed?\n\nBest regards,\nOlalekan', 'Use for businesses with inbox but no reply after the first message.', true),
('00000000-0000-4000-8000-000000000001', 'Default reply: thanks for responding', 'Reply templates', 'reply', 'Re: {last_subject}', array['Re: {business}'], 'Hi {name},\n\nThanks for getting back to me.\n\nThat makes sense. Based on what you said, I can send a short practical breakdown for {business}.\n\nBest regards,\nOlalekan', 'Use only from a business conversation after a prospect replies.', true)
on conflict do nothing;

select pg_notify('pgrst', 'reload schema');

-- <<< END 202607090829_reply_templates_followup_segments.sql

-- >>> BEGIN 202607100833_notifications_durable_jobs.sql
-- Scout v8.33 - persistent notifications and durable job support

create table if not exists public.app_notifications (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  type text not null default 'info',
  title text not null,
  message text,
  entity_type text,
  entity_id text,
  business_id uuid references public.businesses(id) on delete set null,
  read_at timestamptz,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists app_notifications_workspace_created_idx
on public.app_notifications(workspace_id, created_at desc);

create index if not exists app_notifications_workspace_unread_idx
on public.app_notifications(workspace_id, read_at, created_at desc);

create unique index if not exists app_notifications_workspace_entity_type_unique
on public.app_notifications(workspace_id, type, entity_type, entity_id)
where entity_type is not null and entity_id is not null;

alter table public.app_notifications enable row level security;

drop policy if exists app_notifications_member_all on public.app_notifications;
create policy app_notifications_member_all
on public.app_notifications
for all
using (public.is_workspace_member(workspace_id))
with check (public.is_workspace_member(workspace_id));

alter table public.message_schedules add column if not exists run_kind text not null default 'scheduled';
alter table public.message_schedules add column if not exists last_heartbeat_at timestamptz;
alter table public.message_schedules add column if not exists resume_count int not null default 0;
alter table public.message_schedules add column if not exists created_by uuid references auth.users(id) on delete set null;
alter table public.message_schedules add column if not exists target_count int not null default 0;
alter table public.message_schedules add column if not exists processed_count int not null default 0;
alter table public.message_schedules add column if not exists sent_count int not null default 0;
alter table public.message_schedules add column if not exists failed_count int not null default 0;
alter table public.message_schedules add column if not exists skipped_count int not null default 0;
alter table public.message_schedules add column if not exists updated_at timestamptz not null default now();

create index if not exists message_schedules_workspace_running_idx
on public.message_schedules(workspace_id, status, updated_at)
where status = 'running';

create index if not exists message_schedules_workspace_created_idx
on public.message_schedules(workspace_id, created_at desc);

-- Helper view-like function for UI cards. This is safe to re-run.
create or replace function public.get_active_scout_jobs(target_workspace uuid)
returns table(
  job_type text,
  job_id text,
  status text,
  total_count int,
  processed_count int,
  sent_count int,
  failed_count int,
  skipped_count int,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    'message_schedule'::text as job_type,
    ms.id::text as job_id,
    ms.status,
    coalesce(ms.target_count, 0)::int as total_count,
    coalesce(ms.processed_count, 0)::int as processed_count,
    coalesce(ms.sent_count, 0)::int as sent_count,
    coalesce(ms.failed_count, 0)::int as failed_count,
    coalesce(ms.skipped_count, 0)::int as skipped_count,
    ms.created_at,
    ms.updated_at
  from public.message_schedules ms
  where ms.workspace_id = target_workspace
    and ms.status in ('scheduled','due','running')
  union all
  select
    'auto_scout'::text as job_type,
    erj.id::text as job_id,
    erj.status,
    1::int as total_count,
    case when erj.status in ('done','failed','cancelled') then 1 else 0 end::int as processed_count,
    case when erj.status = 'done' then 1 else 0 end::int as sent_count,
    case when erj.status = 'failed' then 1 else 0 end::int as failed_count,
    case when erj.status = 'cancelled' then 1 else 0 end::int as skipped_count,
    erj.created_at,
    erj.updated_at
  from public.email_research_jobs erj
  where erj.workspace_id = target_workspace
    and erj.status in ('queued','running')
  order by updated_at desc;
$$;

-- <<< END 202607100833_notifications_durable_jobs.sql

-- >>> BEGIN 202607100834_email_signatures_identity.sql
-- Scout v8.34 - email identity and signatures

alter table public.gmail_accounts add column if not exists signature_enabled boolean not null default true;
alter table public.gmail_accounts add column if not exists signature_text text;
alter table public.gmail_accounts add column if not exists signature_html text;
alter table public.gmail_accounts add column if not exists profile_picture_url text;
alter table public.gmail_accounts add column if not exists sync_signature_to_gmail boolean not null default false;
alter table public.gmail_accounts add column if not exists gmail_signature_synced_at timestamptz;
alter table public.gmail_accounts add column if not exists gmail_signature_sync_error text;

create index if not exists gmail_accounts_workspace_signature_idx
on public.gmail_accounts(workspace_id, signature_enabled);

-- Optional table for future multiple saved identities/signatures without changing the current UI.
create table if not exists public.email_signature_profiles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null default 'Default Signature',
  signature_text text,
  signature_html text,
  profile_picture_url text,
  active boolean not null default true,
  raw jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists email_signature_profiles_workspace_active_idx
on public.email_signature_profiles(workspace_id, active, created_at desc);

alter table public.email_signature_profiles enable row level security;

drop policy if exists email_signature_profiles_member_all on public.email_signature_profiles;
create policy email_signature_profiles_member_all
on public.email_signature_profiles
for all
using (public.is_workspace_member(workspace_id))
with check (public.is_workspace_member(workspace_id));

-- <<< END 202607100834_email_signatures_identity.sql

-- >>> BEGIN 202607100835_daily_scouting_history.sql
-- Scout v8.35 - daily scouting submission history and migration safety fixes

-- Safety patch for installs that jumped directly to v8.33/v8.34 and missed older schedule columns.
alter table if exists public.message_schedules add column if not exists target_count int not null default 0;
alter table if exists public.message_schedules add column if not exists processed_count int not null default 0;
alter table if exists public.message_schedules add column if not exists sent_count int not null default 0;
alter table if exists public.message_schedules add column if not exists failed_count int not null default 0;
alter table if exists public.message_schedules add column if not exists skipped_count int not null default 0;
alter table if exists public.message_schedules add column if not exists updated_at timestamptz not null default now();

create table if not exists public.daily_scouting_submissions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  scout_date date not null default current_date,
  submitted_by uuid references auth.users(id) on delete set null,
  submitter_email text,
  scout_name text,
  niche text,
  location text,
  country text,
  source_mode text not null default 'mixed',
  notes text,
  raw_text text,
  parsed_count int not null default 0,
  inserted_count int not null default 0,
  skipped_count int not null default 0,
  direct_email_count int not null default 0,
  website_only_count int not null default 0,
  queued_auto_scout_count int not null default 0,
  import_batch_id uuid references public.import_batches(id) on delete set null,
  status text not null default 'submitted',
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.daily_scouting_submissions add column if not exists scout_date date not null default current_date;
alter table public.daily_scouting_submissions add column if not exists submitted_by uuid references auth.users(id) on delete set null;
alter table public.daily_scouting_submissions add column if not exists submitter_email text;
alter table public.daily_scouting_submissions add column if not exists scout_name text;
alter table public.daily_scouting_submissions add column if not exists niche text;
alter table public.daily_scouting_submissions add column if not exists location text;
alter table public.daily_scouting_submissions add column if not exists country text;
alter table public.daily_scouting_submissions add column if not exists source_mode text not null default 'mixed';
alter table public.daily_scouting_submissions add column if not exists notes text;
alter table public.daily_scouting_submissions add column if not exists raw_text text;
alter table public.daily_scouting_submissions add column if not exists parsed_count int not null default 0;
alter table public.daily_scouting_submissions add column if not exists inserted_count int not null default 0;
alter table public.daily_scouting_submissions add column if not exists skipped_count int not null default 0;
alter table public.daily_scouting_submissions add column if not exists direct_email_count int not null default 0;
alter table public.daily_scouting_submissions add column if not exists website_only_count int not null default 0;
alter table public.daily_scouting_submissions add column if not exists queued_auto_scout_count int not null default 0;
alter table public.daily_scouting_submissions add column if not exists import_batch_id uuid references public.import_batches(id) on delete set null;
alter table public.daily_scouting_submissions add column if not exists status text not null default 'submitted';
alter table public.daily_scouting_submissions add column if not exists raw jsonb not null default '{}'::jsonb;
alter table public.daily_scouting_submissions add column if not exists updated_at timestamptz not null default now();

create index if not exists daily_scouting_submissions_workspace_date_idx
on public.daily_scouting_submissions(workspace_id, scout_date desc, created_at desc);

create index if not exists daily_scouting_submissions_workspace_submitter_idx
on public.daily_scouting_submissions(workspace_id, submitted_by, scout_date desc);

alter table public.daily_scouting_submissions enable row level security;

drop policy if exists daily_scouting_submissions_member_all on public.daily_scouting_submissions;
create policy daily_scouting_submissions_member_all
on public.daily_scouting_submissions
for all
using (public.is_workspace_member(workspace_id))
with check (public.is_workspace_member(workspace_id));

drop trigger if exists daily_scouting_submissions_touch_updated_at on public.daily_scouting_submissions;
create trigger daily_scouting_submissions_touch_updated_at
before update on public.daily_scouting_submissions
for each row execute function public.touch_updated_at();

create or replace function public.get_daily_scouting_totals(target_workspace uuid, target_date date default current_date)
returns table(
  submitter_email text,
  scout_name text,
  submissions int,
  parsed_count int,
  inserted_count int,
  direct_email_count int,
  website_only_count int,
  queued_auto_scout_count int,
  last_submitted_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    coalesce(nullif(dss.submitter_email, ''), 'unknown') as submitter_email,
    coalesce(nullif(dss.scout_name, ''), coalesce(nullif(dss.submitter_email, ''), 'Unknown scout')) as scout_name,
    count(*)::int as submissions,
    coalesce(sum(dss.parsed_count), 0)::int as parsed_count,
    coalesce(sum(dss.inserted_count), 0)::int as inserted_count,
    coalesce(sum(dss.direct_email_count), 0)::int as direct_email_count,
    coalesce(sum(dss.website_only_count), 0)::int as website_only_count,
    coalesce(sum(dss.queued_auto_scout_count), 0)::int as queued_auto_scout_count,
    max(dss.created_at) as last_submitted_at
  from public.daily_scouting_submissions dss
  where dss.workspace_id = target_workspace
    and dss.scout_date = target_date
  group by 1, 2
  order by inserted_count desc, parsed_count desc, last_submitted_at desc;
$$;

-- <<< END 202607100835_daily_scouting_history.sql

-- >>> BEGIN 202607100836_audience_categories_admin_setup.sql
-- Scout v8.36 - audience categories, category-aware imports/dorking, and admin deploy URLs

-- One category system is used for both audience buckets and template groups.
create table if not exists public.message_categories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  description text,
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workspace_id, name)
);

alter table public.message_categories add column if not exists description text;
alter table public.message_categories add column if not exists active boolean not null default true;
alter table public.message_categories add column if not exists created_by uuid references auth.users(id) on delete set null;
alter table public.message_categories add column if not exists updated_at timestamptz not null default now();

create index if not exists message_categories_workspace_name_idx on public.message_categories(workspace_id, name);

-- Business/audience category fields.
alter table public.businesses add column if not exists category_id uuid references public.message_categories(id) on delete set null;
alter table public.businesses add column if not exists category_name text;
create index if not exists businesses_workspace_category_id_idx on public.businesses(workspace_id, category_id, status, updated_at desc);

alter table public.import_batches add column if not exists category_id uuid references public.message_categories(id) on delete set null;
alter table public.import_batches add column if not exists category_name text;
alter table public.import_batches add column if not exists source_mode text;

alter table public.scout_history add column if not exists category_id uuid references public.message_categories(id) on delete set null;
alter table public.scout_history add column if not exists category_name text;

alter table public.daily_scouting_submissions add column if not exists category_id uuid references public.message_categories(id) on delete set null;
alter table public.daily_scouting_submissions add column if not exists category_name text;

-- Scheduled jobs keep template category and audience category separate.
alter table public.message_schedules add column if not exists audience_category_id uuid references public.message_categories(id) on delete set null;
alter table public.message_schedules add column if not exists audience_category_name text;
create index if not exists message_schedules_workspace_audience_category_idx on public.message_schedules(workspace_id, audience_category_id, status, scheduled_for);

-- Workspace deploy/setup values that an admin can save for teammates/extensions.
alter table public.workspaces add column if not exists app_url text;
alter table public.workspaces add column if not exists render_backend_url text;
alter table public.workspaces add column if not exists default_audience_category_id uuid references public.message_categories(id) on delete set null;
alter table public.workspaces add column if not exists default_audience_category_name text;
alter table public.workspaces add column if not exists dork_settings jsonb not null default '{}'::jsonb;
alter table public.workspaces add column if not exists extension_settings jsonb not null default '{}'::jsonb;

-- Backfill category_name for old business rows.
update public.businesses
set category_name = coalesce(category_name, category)
where category_name is null and category is not null;

-- Keep category_name in sync when category_id is set.
create or replace function public.sync_business_category_name()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.category_id is not null then
    select name into new.category_name from public.message_categories where id = new.category_id;
  end if;
  if coalesce(new.category_name, '') <> '' and coalesce(new.category, '') = '' then
    new.category = new.category_name;
  end if;
  return new;
end;
$$;

drop trigger if exists businesses_sync_category_name on public.businesses;
create trigger businesses_sync_category_name
before insert or update of category_id, category_name, category on public.businesses
for each row execute function public.sync_business_category_name();

-- Safe grants/RLS for fresh installs.
alter table public.message_categories enable row level security;
drop policy if exists message_categories_member_all on public.message_categories;
create policy message_categories_member_all on public.message_categories
for all using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

-- Helper for creating/finding a category by name from server/client flows.
create or replace function public.ensure_message_category(target_workspace uuid, category_title text, category_description text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_name text := nullif(trim(category_title), '');
  category_uuid uuid;
begin
  if clean_name is null then
    return null;
  end if;
  if auth.uid() is not null and not public.is_workspace_member(target_workspace) then
    raise exception 'User is not approved for this workspace';
  end if;
  insert into public.message_categories (workspace_id, name, description, active, created_by)
  values (target_workspace, clean_name, nullif(trim(category_description), ''), true, auth.uid())
  on conflict (workspace_id, name) do update set active = true, description = coalesce(excluded.description, public.message_categories.description), updated_at = now()
  returning id into category_uuid;
  return category_uuid;
end;
$$;

grant execute on function public.ensure_message_category(uuid, text, text) to authenticated;

-- Category-aware import helper. Existing clients can still call the old function.
-- Safe re-run: replace the previous table-returning version before changing its output columns.
drop function if exists public.import_businesses_chunk_with_category(uuid, uuid, jsonb, uuid, text);

create or replace function public.import_businesses_chunk_with_category(
  target_workspace uuid,
  target_batch_id uuid,
  input_rows jsonb,
  target_category_id uuid default null,
  target_category_name text default null
)
returns table(inserted_count int, skipped_queue_count int, skipped_history_count int, skipped_keys text[])
language plpgsql
security definer
set search_path = public
as $$
declare
  final_category_id uuid := target_category_id;
  final_category_name text := nullif(trim(target_category_name), '');
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if not public.is_workspace_member(target_workspace) then
    raise exception 'User is not approved for this workspace';
  end if;

  if final_category_id is null and final_category_name is not null then
    final_category_id := public.ensure_message_category(target_workspace, final_category_name, null);
  end if;

  if final_category_id is not null then
    select name into final_category_name from public.message_categories where id = final_category_id;
  end if;

  return query
  with incoming as (
    select
      nullif(trim(x.name), '') as name,
      nullif(trim(lower(x.email)), '') as email,
      nullif(trim(x.phone), '') as phone,
      nullif(trim(x.website), '') as website,
      nullif(trim(x.domain), '') as domain,
      coalesce(final_category_name, nullif(trim(x.category), '')) as category,
      final_category_id as category_id,
      final_category_name as category_name,
      nullif(trim(x.location), '') as location,
      coalesce(nullif(trim(x.source), ''), 'csv_upload') as source,
      nullif(trim(x.normalized_key), '') as normalized_key,
      coalesce(x.raw, '{}'::jsonb) as raw
    from jsonb_to_recordset(coalesce(input_rows, '[]'::jsonb)) as x(
      name text,
      email text,
      phone text,
      website text,
      domain text,
      category text,
      location text,
      source text,
      normalized_key text,
      raw jsonb
    )
    where nullif(trim(x.normalized_key), '') is not null
  ),
  deduped as (
    select distinct on (normalized_key) * from incoming order by normalized_key
  ),
  queue_existing as (
    select d.normalized_key
    from deduped d
    join public.businesses b on b.workspace_id = target_workspace and b.normalized_key = d.normalized_key
  ),
  history_existing as (
    select d.normalized_key
    from deduped d
    join public.scout_history h on h.workspace_id = target_workspace and h.normalized_key = d.normalized_key
    where not exists (select 1 from queue_existing q where q.normalized_key = d.normalized_key)
  ),
  skipped as (
    select normalized_key from queue_existing union select normalized_key from history_existing
  ),
  inserted as (
    insert into public.businesses (
      workspace_id, import_batch_id, name, email, phone, website, domain, category, category_id, category_name,
      location, source, status, score, normalized_key, raw, created_by
    )
    select
      target_workspace, target_batch_id, d.name, d.email, d.phone, d.website, d.domain, d.category, d.category_id, d.category_name,
      d.location, d.source,
      case when coalesce(nullif(d.email, ''), '') <> '' then 'ready' else 'pending' end,
      case when coalesce(nullif(d.email, ''), '') <> '' then 75 else null end,
      d.normalized_key, d.raw, auth.uid()
    from deduped d
    where not exists (select 1 from skipped s where s.normalized_key = d.normalized_key)
    on conflict (workspace_id, normalized_key) do nothing
    returning normalized_key
  )
  select
    (select count(*)::int from inserted) as inserted_count,
    (select count(*)::int from queue_existing) as skipped_queue_count,
    (select count(*)::int from history_existing) as skipped_history_count,
    coalesce((select array_agg(normalized_key) from skipped), array[]::text[]) as skipped_keys;
end;
$$;

grant execute on function public.import_businesses_chunk_with_category(uuid, uuid, jsonb, uuid, text) to authenticated;

-- <<< END 202607100836_audience_categories_admin_setup.sql

-- >>> BEGIN 202607100839_simple_targeting_followup_rpc.sql
-- Scout v8.39: simple targeting + follow-up RPC repair
-- Run this once in Supabase SQL Editor after deploying v8.39.

create table if not exists public.message_categories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  description text,
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workspace_id, name)
);

alter table if exists public.workspaces add column if not exists app_url text;
alter table if exists public.workspaces add column if not exists render_backend_url text;
alter table if exists public.workspaces add column if not exists default_audience_category_id uuid references public.message_categories(id) on delete set null;
alter table if exists public.workspaces add column if not exists default_audience_category_name text;
alter table if exists public.workspaces add column if not exists dork_settings jsonb not null default '{}'::jsonb;
alter table if exists public.workspaces add column if not exists extension_settings jsonb not null default '{}'::jsonb;
alter table if exists public.workspaces add column if not exists updated_at timestamptz not null default now();

alter table if exists public.businesses add column if not exists category_id uuid references public.message_categories(id) on delete set null;
alter table if exists public.businesses add column if not exists category_name text;
alter table if exists public.import_batches add column if not exists category_id uuid references public.message_categories(id) on delete set null;
alter table if exists public.import_batches add column if not exists category_name text;
alter table if exists public.import_batches add column if not exists source_mode text;
alter table if exists public.scout_history add column if not exists category_id uuid references public.message_categories(id) on delete set null;
alter table if exists public.scout_history add column if not exists category_name text;
alter table if exists public.daily_scouting_submissions add column if not exists category_id uuid references public.message_categories(id) on delete set null;
alter table if exists public.daily_scouting_submissions add column if not exists category_name text;
alter table if exists public.templates add column if not exists category_id uuid references public.message_categories(id) on delete set null;
alter table if exists public.templates add column if not exists category_name text;
alter table if exists public.message_schedules add column if not exists audience_category_id uuid references public.message_categories(id) on delete set null;
alter table if exists public.message_schedules add column if not exists audience_category_name text;
alter table if exists public.message_schedules add column if not exists category_id uuid references public.message_categories(id) on delete set null;
alter table if exists public.message_schedules add column if not exists followup_segment text;
alter table if exists public.message_schedules add column if not exists target_count int not null default 0;
alter table if exists public.message_schedules add column if not exists processed_count int not null default 0;
alter table if exists public.message_schedules add column if not exists sent_count int not null default 0;
alter table if exists public.message_schedules add column if not exists failed_count int not null default 0;
alter table if exists public.message_schedules add column if not exists skipped_count int not null default 0;
alter table if exists public.message_schedules add column if not exists updated_at timestamptz not null default now();
alter table if exists public.no_inbox_records add column if not exists to_email text;
alter table if exists public.no_inbox_records add column if not exists business_id uuid;
alter table if exists public.no_inbox_records add column if not exists email text;
alter table if exists public.no_inbox_records add column if not exists created_at timestamptz not null default now();
alter table if exists public.reply_history add column if not exists is_real_reply boolean not null default false;
alter table if exists public.reply_history add column if not exists is_auto_reply boolean not null default false;
alter table if exists public.reply_history add column if not exists reply_bucket text;
alter table if exists public.reply_history add column if not exists received_at timestamptz not null default now();

create index if not exists message_categories_workspace_name_idx on public.message_categories(workspace_id, name);
create index if not exists businesses_workspace_category_id_idx on public.businesses(workspace_id, category_id, status, updated_at desc);
create index if not exists templates_workspace_category_id_idx on public.templates(workspace_id, category_id, active, created_at desc);
create index if not exists message_schedules_workspace_audience_category_idx on public.message_schedules(workspace_id, audience_category_id, status, scheduled_for);

insert into public.message_categories (workspace_id, name, description, active)
select w.id, category_name, category_description, true
from public.workspaces w
cross join (values
  ('Airtable', 'Audience and templates for Airtable service outreach.'),
  ('Shopify', 'Audience and templates for Shopify / ecommerce outreach.')
) as seed(category_name, category_description)
on conflict (workspace_id, name) do update set active = true, description = excluded.description, updated_at = now();

-- Keep old text categories connected to the new category records where names match.
update public.businesses b
set category_id = c.id,
    category_name = c.name
from public.message_categories c
where b.workspace_id = c.workspace_id
  and b.category_id is null
  and lower(coalesce(b.category_name, b.category, '')) = lower(c.name);

update public.templates t
set category_id = c.id,
    category_name = c.name
from public.message_categories c
where t.workspace_id = c.workspace_id
  and t.category_id is null
  and lower(coalesce(t.category_name, '')) = lower(c.name);

-- Safe re-run: PostgreSQL cannot change a table-returning function's output columns in place.
drop function if exists public.get_due_followups(uuid, integer, text);

drop function if exists public.count_due_followups(uuid, text);
drop function if exists public.get_due_followups(uuid, integer, text);
create function public.get_due_followups(
  target_workspace uuid,
  limit_rows int default 100,
  followup_segment text default 'all_unanswered'
)
returns table(
  business_id uuid,
  business_name text,
  to_email text,
  last_sent_at timestamptz,
  last_subject text,
  template_id uuid,
  gmail_account_id uuid,
  segment text,
  reply_state text,
  last_auto_reply_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if auth.uid() is null then
      raise exception 'Not authenticated';
    end if;
    if not public.is_workspace_member(target_workspace) then
      raise exception 'User is not approved for this workspace';
    end if;
  end if;

  return query
  with latest_sent as (
    select distinct on (s.business_id)
      s.business_id,
      s.to_email,
      s.sent_at,
      s.subject,
      s.template_id,
      s.gmail_account_id
    from public.sent_messages s
    where s.workspace_id = target_workspace
      and s.status = 'sent'
      and s.sent_at <= now() - interval '72 hours'
      and s.business_id is not null
      and coalesce(s.delivery_status, '') <> 'manual_reply_sent'
    order by s.business_id, s.sent_at desc
  ), classified as (
    select
      b.id as business_id,
      b.name as business_name,
      coalesce(nullif(l.to_email, ''), b.email) as to_email,
      l.sent_at as last_sent_at,
      l.subject as last_subject,
      l.template_id,
      l.gmail_account_id,
      b.reply_state,
      b.last_auto_reply_at,
      exists (
        select 1 from public.reply_history r
        where r.workspace_id = target_workspace
          and r.business_id = b.id
          and (coalesce(r.is_real_reply, false) = true or r.reply_bucket = 'real_reply')
          and r.received_at >= l.sent_at
      ) as has_real_reply,
      exists (
        select 1 from public.reply_history r
        where r.workspace_id = target_workspace
          and r.business_id = b.id
          and (coalesce(r.is_auto_reply, false) = true or r.reply_bucket = 'auto_reply')
          and r.received_at >= l.sent_at
      ) as has_auto_reply,
      exists (
        select 1 from public.reply_history r
        where r.workspace_id = target_workspace
          and r.business_id = b.id
          and (coalesce(r.is_real_reply, false) = true or coalesce(r.is_auto_reply, false) = true or r.reply_bucket in ('real_reply', 'auto_reply'))
          and r.received_at >= l.sent_at
      ) as has_any_reply,
      exists (
        select 1 from public.no_inbox_records n
        where n.workspace_id = target_workspace
          and (n.business_id = b.id or lower(coalesce(n.email, n.to_email, '')) = lower(coalesce(l.to_email, b.email, '')))
          and n.created_at >= l.sent_at
      ) as has_delivery_failure
    from latest_sent l
    join public.businesses b on b.id = l.business_id and b.workspace_id = target_workspace
    where b.status in ('contacted', 'ready', 'found', 'review')
      and coalesce(nullif(l.to_email, ''), b.email, '') <> ''
  )
  select
    c.business_id,
    c.business_name,
    c.to_email,
    c.last_sent_at,
    c.last_subject,
    c.template_id,
    c.gmail_account_id,
    case when c.has_auto_reply then 'auto_reply' else 'no_reply' end as segment,
    c.reply_state,
    c.last_auto_reply_at
  from classified c
  where c.has_real_reply = false
    and c.has_delivery_failure = false
    and (
      coalesce(followup_segment, 'all_unanswered') = 'all_unanswered'
      or (followup_segment = 'no_reply' and c.has_any_reply = false)
      or (followup_segment = 'auto_reply' and c.has_auto_reply = true)
    )
  order by c.last_sent_at asc
  limit greatest(1, least(coalesce(limit_rows, 100), 5000));
end;
$$;

grant execute on function public.get_due_followups(uuid, int, text) to authenticated;
grant execute on function public.get_due_followups(uuid, int, text) to service_role;

select pg_notify('pgrst', 'reload schema');

-- <<< END 202607100839_simple_targeting_followup_rpc.sql

-- >>> BEGIN 202607100842_repair_notifications_signatures_sources.sql
-- Scout v8.42 repair: notifications, schedules, signatures/logo, categories, follow-ups, and schema cache reload.
-- Run once in Supabase SQL Editor after deploying v8.42.

create extension if not exists pgcrypto;

-- Notifications bell
create table if not exists public.app_notifications (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid,
  type text not null default 'info',
  title text not null,
  message text,
  entity_type text,
  entity_id text,
  business_id uuid,
  read_at timestamptz,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.app_notifications add column if not exists workspace_id uuid;
alter table public.app_notifications add column if not exists user_id uuid;
alter table public.app_notifications add column if not exists type text not null default 'info';
alter table public.app_notifications add column if not exists title text not null default 'Notification';
alter table public.app_notifications add column if not exists message text;
alter table public.app_notifications add column if not exists entity_type text;
alter table public.app_notifications add column if not exists entity_id text;
alter table public.app_notifications add column if not exists business_id uuid;
alter table public.app_notifications add column if not exists read_at timestamptz;
alter table public.app_notifications add column if not exists raw jsonb not null default '{}'::jsonb;
alter table public.app_notifications add column if not exists created_at timestamptz not null default now();
create unique index if not exists app_notifications_dedupe_idx on public.app_notifications(workspace_id, type, entity_type, entity_id) where entity_type is not null and entity_id is not null;
create index if not exists app_notifications_workspace_unread_idx on public.app_notifications(workspace_id, read_at, created_at desc);

alter table public.app_notifications enable row level security;
drop policy if exists app_notifications_member_all on public.app_notifications;
create policy app_notifications_member_all on public.app_notifications for all using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

grant select, insert, update, delete on public.app_notifications to authenticated;

-- Message schedules: durable sending, progress, stop button, and worker recovery.
alter table if exists public.message_schedules add column if not exists run_kind text;
alter table if exists public.message_schedules add column if not exists category_id uuid;
alter table if exists public.message_schedules add column if not exists audience_category_id uuid;
alter table if exists public.message_schedules add column if not exists audience_category_name text;
alter table if exists public.message_schedules add column if not exists template_id uuid;
alter table if exists public.message_schedules add column if not exists followup_segment text;
alter table if exists public.message_schedules add column if not exists target_count int not null default 0;
alter table if exists public.message_schedules add column if not exists processed_count int not null default 0;
alter table if exists public.message_schedules add column if not exists sent_count int not null default 0;
alter table if exists public.message_schedules add column if not exists failed_count int not null default 0;
alter table if exists public.message_schedules add column if not exists skipped_count int not null default 0;
alter table if exists public.message_schedules add column if not exists batch_id text;
alter table if exists public.message_schedules add column if not exists raw jsonb not null default '{}'::jsonb;
alter table if exists public.message_schedules add column if not exists worker_options jsonb not null default '{}'::jsonb;
alter table if exists public.message_schedules add column if not exists last_error text;
alter table if exists public.message_schedules add column if not exists started_at timestamptz;
alter table if exists public.message_schedules add column if not exists finished_at timestamptz;
alter table if exists public.message_schedules add column if not exists completed_at timestamptz;
alter table if exists public.message_schedules add column if not exists last_heartbeat_at timestamptz;
alter table if exists public.message_schedules add column if not exists stop_requested boolean not null default false;
alter table if exists public.message_schedules add column if not exists stopped_at timestamptz;
alter table if exists public.message_schedules add column if not exists resume_count int not null default 0;
alter table if exists public.message_schedules add column if not exists created_by uuid;
alter table if exists public.message_schedules add column if not exists updated_at timestamptz not null default now();

-- Gmail sender identity/signature columns. Scout-local signatures do not require reconnecting Gmail.
alter table if exists public.gmail_accounts add column if not exists signature_enabled boolean not null default true;
alter table if exists public.gmail_accounts add column if not exists signature_text text;
alter table if exists public.gmail_accounts add column if not exists signature_html text;
alter table if exists public.gmail_accounts add column if not exists signature_logo_url text;
alter table if exists public.gmail_accounts add column if not exists sync_signature_to_gmail boolean not null default false;
alter table if exists public.gmail_accounts add column if not exists gmail_signature_synced_at timestamptz;
alter table if exists public.gmail_accounts add column if not exists gmail_signature_sync_error text;
alter table if exists public.gmail_accounts add column if not exists default_run_limit int;
alter table if exists public.gmail_accounts add column if not exists daily_limit int not null default 450;
alter table if exists public.gmail_accounts add column if not exists sent_today int not null default 0;
alter table if exists public.gmail_accounts add column if not exists last_error text;
alter table if exists public.gmail_accounts add column if not exists paused_until timestamptz;
alter table if exists public.gmail_accounts add column if not exists updated_at timestamptz not null default now();

-- Workspace/admin setup columns used by simplified Settings and extension.
alter table if exists public.workspaces add column if not exists app_url text;
alter table if exists public.workspaces add column if not exists render_backend_url text;
alter table if exists public.workspaces add column if not exists default_audience_category_id uuid;
alter table if exists public.workspaces add column if not exists default_audience_category_name text;
alter table if exists public.workspaces add column if not exists dork_settings jsonb not null default '{}'::jsonb;
alter table if exists public.workspaces add column if not exists extension_settings jsonb not null default '{}'::jsonb;
alter table if exists public.workspaces add column if not exists updated_at timestamptz not null default now();

create table if not exists public.message_categories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  description text,
  active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workspace_id, name)
);

insert into public.message_categories (workspace_id, name, description, active)
select w.id, 'Airtable', 'Audience/template category for Airtable-related outreach.', true from public.workspaces w
on conflict (workspace_id, name) do nothing;
insert into public.message_categories (workspace_id, name, description, active)
select w.id, 'Shopify', 'Audience/template category for Shopify-related outreach.', true from public.workspaces w
on conflict (workspace_id, name) do nothing;

alter table if exists public.businesses add column if not exists category_id uuid;
alter table if exists public.businesses add column if not exists category_name text;
alter table if exists public.businesses add column if not exists reply_state text;
alter table if exists public.businesses add column if not exists last_real_reply_at timestamptz;
alter table if exists public.businesses add column if not exists last_auto_reply_at timestamptz;
alter table if exists public.businesses add column if not exists last_inbound_at timestamptz;

alter table if exists public.import_batches add column if not exists category_id uuid;
alter table if exists public.import_batches add column if not exists category_name text;
alter table if exists public.import_batches add column if not exists source_mode text;

alter table if exists public.reply_history add column if not exists is_real_reply boolean not null default false;
alter table if exists public.reply_history add column if not exists is_auto_reply boolean not null default false;
alter table if exists public.reply_history add column if not exists is_delivery_failure boolean not null default false;
alter table if exists public.reply_history add column if not exists is_blocked boolean not null default false;
alter table if exists public.reply_history add column if not exists is_limit_notice boolean not null default false;
alter table if exists public.reply_history add column if not exists is_temporary boolean not null default false;
alter table if exists public.reply_history add column if not exists reply_bucket text;
alter table if exists public.reply_history add column if not exists received_at timestamptz;
alter table if exists public.reply_history add column if not exists gmail_message_id text;
alter table if exists public.reply_history add column if not exists gmail_thread_id text;

alter table if exists public.sent_messages add column if not exists is_follow_up boolean not null default false;
alter table if exists public.sent_messages add column if not exists gmail_thread_id text;
alter table if exists public.sent_messages add column if not exists delivery_status text;
alter table if exists public.sent_messages add column if not exists error_code text;
alter table if exists public.sent_messages add column if not exists last_reply_at timestamptz;
alter table if exists public.sent_messages add column if not exists raw jsonb not null default '{}'::jsonb;

create index if not exists message_schedules_workspace_status_due_idx on public.message_schedules(workspace_id, status, scheduled_for);
create index if not exists message_schedules_workspace_stop_idx on public.message_schedules(workspace_id, stop_requested, status);
create index if not exists sent_messages_workspace_business_sent_idx on public.sent_messages(workspace_id, business_id, sent_at desc);
create index if not exists reply_history_workspace_business_received_idx on public.reply_history(workspace_id, business_id, received_at desc);
create index if not exists businesses_workspace_category_status_idx on public.businesses(workspace_id, category_id, status, updated_at desc);
create unique index if not exists reply_history_workspace_gmail_message_uid on public.reply_history(workspace_id, gmail_message_id) where gmail_message_id is not null;

-- Follow-up RPC used by Message, Dashboard, Automation, and worker.
-- Safe re-run: PostgreSQL cannot change a table-returning function's output columns in place.
drop function if exists public.get_due_followups(uuid, integer, text);

drop function if exists public.count_due_followups(uuid, text);
drop function if exists public.get_due_followups(uuid, integer, text);
create function public.get_due_followups(
  target_workspace uuid,
  limit_rows int default 100,
  followup_segment text default 'all_unanswered'
)
returns table (
  business_id uuid,
  business_name text,
  to_email text,
  website text,
  last_sent_at timestamptz,
  last_subject text,
  template_id uuid,
  gmail_account_id uuid,
  followup_segment text,
  reply_state text,
  last_auto_reply_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  with last_sent as (
    select distinct on (sm.business_id)
      sm.business_id,
      sm.sent_at,
      sm.subject,
      sm.template_id,
      sm.gmail_account_id
    from public.sent_messages sm
    where sm.workspace_id = target_workspace
      and sm.status in ('sent', 'delivered', 'dry_run')
    order by sm.business_id, sm.sent_at desc nulls last
  ), reply_flags as (
    select
      rh.business_id,
      bool_or(coalesce(rh.is_real_reply, false)) as has_real_reply,
      bool_or(coalesce(rh.is_auto_reply, false)) as has_auto_reply,
      bool_or(coalesce(rh.is_delivery_failure, false) or coalesce(rh.is_blocked, false)) as has_bad_inbox,
      max(case when coalesce(rh.is_auto_reply, false) then rh.received_at else null end) as auto_reply_at
    from public.reply_history rh
    where rh.workspace_id = target_workspace
    group by rh.business_id
  )
  select
    b.id as business_id,
    coalesce(b.name, '') as business_name,
    coalesce(b.email, '') as to_email,
    coalesce(b.website, '') as website,
    ls.sent_at as last_sent_at,
    ls.subject as last_subject,
    ls.template_id,
    ls.gmail_account_id,
    case when coalesce(rf.has_auto_reply, false) then 'auto_reply' else 'no_reply' end as followup_segment,
    case when coalesce(rf.has_auto_reply, false) then 'auto_reply' else 'no_reply' end as reply_state,
    rf.auto_reply_at as last_auto_reply_at
  from public.businesses b
  join last_sent ls on ls.business_id = b.id
  left join reply_flags rf on rf.business_id = b.id
  where b.workspace_id = target_workspace
    and coalesce(b.email, '') <> ''
    and coalesce(b.status, '') not in ('responded', 'bad_inbox', 'bounced', 'no_inbox', 'blocked', 'invalid', 'duplicate', 'archived')
    and ls.sent_at <= now() - interval '72 hours'
    and coalesce(rf.has_real_reply, false) = false
    and coalesce(rf.has_bad_inbox, false) = false
    and (
      $3 in ('all', 'all_unanswered', '')
      or ($3 = 'no_reply' and coalesce(rf.has_auto_reply, false) = false)
      or ($3 = 'auto_reply' and coalesce(rf.has_auto_reply, false) = true)
    )
  order by ls.sent_at asc
  limit greatest(1, limit_rows);
$$;

grant execute on function public.get_due_followups(uuid, int, text) to authenticated;

-- Reset schema cache for PostgREST/Supabase API.
notify pgrst, 'reload schema';

-- <<< END 202607100842_repair_notifications_signatures_sources.sql

-- >>> BEGIN 202607120105_sender_limit_template_attachments.sql
-- Scout v10.5: sender limit pause + template attachments

alter table if exists public.gmail_accounts
add column if not exists is_paused boolean not null default false;

alter table if exists public.gmail_accounts
add column if not exists paused_reason text;

alter table if exists public.gmail_accounts
add column if not exists paused_until timestamptz;

alter table if exists public.gmail_accounts
add column if not exists last_error text;

alter table if exists public.templates
add column if not exists attachments jsonb not null default '[]'::jsonb;

alter table if exists public.templates
add column if not exists raw jsonb not null default '{}'::jsonb;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'message-attachments',
  'message-attachments',
  true,
  10485760,
  array[
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/webp',
    'image/gif',
    'text/plain',
    'text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ]
)
on conflict (id) do update
set public = true,
    file_size_limit = 10485760,
    allowed_mime_types = array[
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/jpg',
      'image/webp',
      'image/gif',
      'text/plain',
      'text/csv',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    ];

notify pgrst, 'reload schema';

-- <<< END 202607120105_sender_limit_template_attachments.sql

-- >>> BEGIN 202607140629_private_user_workspaces_admin_notifications.sql
-- Scout v10.29
-- Private workspace per user + admin notification on signup.
-- Run once in Supabase SQL editor. Safe to run again.

create extension if not exists pgcrypto;

alter table if exists public.workspaces add column if not exists owner_id uuid;
alter table if exists public.workspaces add column if not exists api_key text;
alter table if exists public.workspaces add column if not exists app_url text;
alter table if exists public.workspaces add column if not exists render_backend_url text;
alter table if exists public.workspaces add column if not exists default_audience_category_id uuid;
alter table if exists public.workspaces add column if not exists default_audience_category_name text;
alter table if exists public.workspaces add column if not exists dork_settings jsonb not null default '{}'::jsonb;
alter table if exists public.workspaces add column if not exists extension_settings jsonb not null default '{}'::jsonb;
alter table if exists public.workspaces add column if not exists email_signature_text text;
alter table if exists public.workspaces add column if not exists email_signature_html text;
alter table if exists public.workspaces add column if not exists email_logo_url text;
alter table if exists public.workspaces add column if not exists created_at timestamptz not null default now();
alter table if exists public.workspaces add column if not exists updated_at timestamptz not null default now();

update public.workspaces
set api_key = coalesce(nullif(api_key, ''), encode(gen_random_bytes(32), 'hex'))
where api_key is null or api_key = '';

create unique index if not exists workspaces_api_key_unique_idx on public.workspaces(api_key);
create index if not exists workspaces_owner_idx on public.workspaces(owner_id);

create table if not exists public.app_notifications (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  user_id uuid,
  type text not null default 'info',
  title text not null default 'Notification',
  message text,
  entity_type text,
  entity_id text,
  business_id uuid,
  read_at timestamptz,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists app_notifications_workspace_unread_idx
on public.app_notifications(workspace_id, read_at, created_at desc);

create unique index if not exists app_notifications_dedupe_idx
on public.app_notifications(workspace_id, type, entity_type, entity_id)
where entity_type is not null and entity_id is not null;

-- Replace the old trigger that placed every signup inside the same shared workspace.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  admin_email text := 'legacy-admin-disabled@invalid.local';
  admin_workspace uuid := '00000000-0000-4000-8000-000000000001';
  new_role text;
  personal_workspace uuid;
  source_workspace public.workspaces%rowtype;
begin
  new_role := case when lower(coalesce(new.email, '')) = admin_email then 'admin' else 'member' end;

  insert into public.profiles (id, email, role, status)
  values (new.id, coalesce(new.email, ''), new_role, 'approved')
  on conflict (id) do update
    set email = excluded.email,
        role = excluded.role,
        status = 'approved',
        updated_at = now();

  insert into public.workspaces (id, name, owner_id, api_key)
  values (admin_workspace, 'Oyeola Scout Admin', case when new_role = 'admin' then new.id else null end, encode(gen_random_bytes(32), 'hex'))
  on conflict (id) do nothing;

  if new_role = 'admin' then
    insert into public.workspace_members (workspace_id, user_id, role, approved)
    values (admin_workspace, new.id, 'admin', true)
    on conflict (workspace_id, user_id) do update set role = 'admin', approved = true;

    update public.workspaces
    set owner_id = new.id,
        name = coalesce(nullif(name, ''), 'Oyeola Scout Admin'),
        updated_at = now()
    where id = admin_workspace;
  else
    select * into source_workspace from public.workspaces where id = admin_workspace;

    insert into public.workspaces (
      name,
      owner_id,
      api_key,
      app_url,
      render_backend_url,
      default_audience_category_id,
      default_audience_category_name,
      dork_settings,
      extension_settings
    )
    values (
      'Scout Workspace - ' || coalesce(new.email, new.id::text),
      new.id,
      encode(gen_random_bytes(32), 'hex'),
      source_workspace.app_url,
      source_workspace.render_backend_url,
      source_workspace.default_audience_category_id,
      source_workspace.default_audience_category_name,
      coalesce(source_workspace.dork_settings, '{}'::jsonb),
      coalesce(source_workspace.extension_settings, '{}'::jsonb)
    )
    returning id into personal_workspace;

    insert into public.workspace_members (workspace_id, user_id, role, approved)
    values (personal_workspace, new.id, 'admin', true)
    on conflict (workspace_id, user_id) do update set role = 'admin', approved = true;

    insert into public.app_notifications (
      workspace_id,
      type,
      title,
      message,
      entity_type,
      entity_id,
      raw
    )
    values (
      admin_workspace,
      'new_signup',
      'New Scout signup',
      coalesce(new.email, 'A new user') || ' created a new private Scout account.',
      'auth_user',
      new.id::text,
      jsonb_build_object('email', new.email, 'user_id', new.id, 'workspace_id', personal_workspace)
    )
    on conflict do nothing;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- Repair existing accounts that were previously sharing the admin workspace.
do $$
declare
  admin_email text := 'legacy-admin-disabled@invalid.local';
  admin_workspace uuid := '00000000-0000-4000-8000-000000000001';
  source_workspace public.workspaces%rowtype;
  u record;
  personal_workspace uuid;
begin
  insert into public.workspaces (id, name, api_key)
  values (admin_workspace, 'Oyeola Scout Admin', encode(gen_random_bytes(32), 'hex'))
  on conflict (id) do nothing;

  select * into source_workspace from public.workspaces where id = admin_workspace;

  for u in
    select id, email
    from auth.users
    where lower(coalesce(email, '')) <> admin_email
  loop
    select w.id into personal_workspace
    from public.workspaces w
    join public.workspace_members wm on wm.workspace_id = w.id and wm.user_id = u.id
    where w.id <> admin_workspace
    order by w.created_at asc
    limit 1;

    if personal_workspace is null then
      insert into public.workspaces (
        name,
        owner_id,
        api_key,
        app_url,
        render_backend_url,
        default_audience_category_id,
        default_audience_category_name,
        dork_settings,
        extension_settings
      )
      values (
        'Scout Workspace - ' || coalesce(u.email, u.id::text),
        u.id,
        encode(gen_random_bytes(32), 'hex'),
        source_workspace.app_url,
        source_workspace.render_backend_url,
        source_workspace.default_audience_category_id,
        source_workspace.default_audience_category_name,
        coalesce(source_workspace.dork_settings, '{}'::jsonb),
        coalesce(source_workspace.extension_settings, '{}'::jsonb)
      )
      returning id into personal_workspace;
    end if;

    insert into public.workspace_members (workspace_id, user_id, role, approved)
    values (personal_workspace, u.id, 'admin', true)
    on conflict (workspace_id, user_id) do update set role = 'admin', approved = true;

    delete from public.workspace_members
    where workspace_id = admin_workspace
      and user_id = u.id;
  end loop;

  update public.profiles
  set role = case when lower(coalesce(email, '')) = admin_email then 'admin' else 'member' end,
      status = 'approved',
      updated_at = now();
end $$;

notify pgrst, 'reload schema';

-- <<< END 202607140629_private_user_workspaces_admin_notifications.sql

-- >>> BEGIN SUPABASE_V10_30_TEAM_DUPLICATE_GUARD_ADMIN_DASHBOARD.sql
-- Scout v10.30
-- Team duplicate guard + admin-only Team Dashboard.
-- Run once in Supabase SQL editor after deploying v10.30. Safe to run more than once.

create extension if not exists pgcrypto;

-- Registry: one normalized prospect key can belong to the team only once.
create table if not exists public.team_scouted_leads (
  normalized_key text primary key,
  first_workspace_id uuid references public.workspaces(id) on delete set null,
  first_business_id uuid,
  first_user_id uuid,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  email text,
  website text,
  domain text,
  name text,
  source text,
  raw jsonb not null default '{}'::jsonb
);

create index if not exists team_scouted_leads_workspace_idx on public.team_scouted_leads(first_workspace_id);
create index if not exists businesses_workspace_key_idx on public.businesses(workspace_id, normalized_key);
create index if not exists businesses_key_idx on public.businesses(normalized_key);
create index if not exists sent_messages_workspace_status_idx on public.sent_messages(workspace_id, status);
create index if not exists sent_messages_workspace_from_idx on public.sent_messages(workspace_id, from_email);
create index if not exists reply_history_workspace_real_idx on public.reply_history(workspace_id, is_real_reply);

-- Backfill the team registry from existing leads. First created owner keeps the prospect.
insert into public.team_scouted_leads (
  normalized_key,
  first_workspace_id,
  first_business_id,
  first_user_id,
  first_seen_at,
  last_seen_at,
  email,
  website,
  domain,
  name,
  source,
  raw
)
select distinct on (b.normalized_key)
  b.normalized_key,
  b.workspace_id,
  b.id,
  b.created_by,
  coalesce(b.created_at, now()),
  coalesce(b.updated_at, b.created_at, now()),
  nullif(b.email, ''),
  nullif(b.website, ''),
  nullif(b.domain, ''),
  nullif(b.name, ''),
  nullif(b.source, ''),
  jsonb_build_object('backfilled_at', now(), 'status', b.status)
from public.businesses b
where nullif(trim(coalesce(b.normalized_key, '')), '') is not null
order by b.normalized_key, coalesce(b.created_at, now()) asc
on conflict (normalized_key) do nothing;

create or replace function public.record_team_scouted_lead()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if nullif(trim(coalesce(new.normalized_key, '')), '') is null then
    return new;
  end if;

  insert into public.team_scouted_leads (
    normalized_key,
    first_workspace_id,
    first_business_id,
    first_user_id,
    first_seen_at,
    last_seen_at,
    email,
    website,
    domain,
    name,
    source,
    raw
  )
  values (
    new.normalized_key,
    new.workspace_id,
    new.id,
    new.created_by,
    coalesce(new.created_at, now()),
    now(),
    nullif(new.email, ''),
    nullif(new.website, ''),
    nullif(new.domain, ''),
    nullif(new.name, ''),
    nullif(new.source, ''),
    jsonb_build_object('status', new.status, 'recorded_at', now())
  )
  on conflict (normalized_key) do update
    set last_seen_at = now();

  return new;
end;
$$;

drop trigger if exists businesses_record_team_scouted_lead on public.businesses;
create trigger businesses_record_team_scouted_lead
after insert or update of normalized_key, email, website, domain on public.businesses
for each row execute function public.record_team_scouted_lead();

create or replace function public.team_duplicate_keys(input_keys text[], target_workspace uuid default null)
returns table(normalized_key text)
language sql
security definer
set search_path = public
as $$
  select t.normalized_key
  from public.team_scouted_leads t
  where t.normalized_key = any(coalesce(input_keys, array[]::text[]))
    and (target_workspace is null or t.first_workspace_id is distinct from target_workspace);
$$;

grant execute on function public.team_duplicate_keys(text[], uuid) to authenticated;

-- Replace the category-aware import helper so CSV uploads skip prospects already claimed by another workspace.
-- Safe re-run: replace the previous table-returning version before changing its output columns.
drop function if exists public.import_businesses_chunk_with_category(uuid, uuid, jsonb, uuid, text);

create or replace function public.import_businesses_chunk_with_category(
  target_workspace uuid,
  target_batch_id uuid,
  input_rows jsonb,
  target_category_id uuid default null,
  target_category_name text default null
)
returns table(inserted_count int, skipped_queue_count int, skipped_history_count int, skipped_team_count int, skipped_keys text[])
language plpgsql
security definer
set search_path = public
as $$
declare
  final_category_id uuid := target_category_id;
  final_category_name text := nullif(trim(target_category_name), '');
  team_removed int := 0;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if not public.is_workspace_member(target_workspace) then
    raise exception 'User is not approved for this workspace';
  end if;

  if final_category_id is null and final_category_name is not null then
    final_category_id := public.ensure_message_category(target_workspace, final_category_name, null);
  end if;

  if final_category_id is not null then
    select name into final_category_name from public.message_categories where id = final_category_id;
  end if;

  return query
  with incoming as (
    select
      nullif(trim(x.name), '') as name,
      nullif(trim(lower(x.email)), '') as email,
      nullif(trim(x.phone), '') as phone,
      nullif(trim(x.website), '') as website,
      nullif(trim(x.domain), '') as domain,
      coalesce(final_category_name, nullif(trim(x.category), '')) as category,
      final_category_id as category_id,
      final_category_name as category_name,
      nullif(trim(x.location), '') as location,
      coalesce(nullif(trim(x.source), ''), 'csv_upload') as source,
      nullif(trim(x.normalized_key), '') as normalized_key,
      coalesce(x.raw, '{}'::jsonb) as raw
    from jsonb_to_recordset(coalesce(input_rows, '[]'::jsonb)) as x(
      name text,
      email text,
      phone text,
      website text,
      domain text,
      category text,
      location text,
      source text,
      normalized_key text,
      raw jsonb
    )
    where nullif(trim(x.normalized_key), '') is not null
  ),
  deduped as (
    select distinct on (normalized_key) * from incoming order by normalized_key
  ),
  queue_existing as (
    select d.normalized_key
    from deduped d
    join public.businesses b on b.workspace_id = target_workspace and b.normalized_key = d.normalized_key
  ),
  team_existing as (
    select d.normalized_key
    from deduped d
    join public.team_scouted_leads t on t.normalized_key = d.normalized_key
    where t.first_workspace_id is distinct from target_workspace
      and not exists (select 1 from queue_existing q where q.normalized_key = d.normalized_key)
  ),
  history_existing as (
    select d.normalized_key
    from deduped d
    join public.scout_history h on h.workspace_id = target_workspace and h.normalized_key = d.normalized_key
    where not exists (select 1 from queue_existing q where q.normalized_key = d.normalized_key)
      and not exists (select 1 from team_existing te where te.normalized_key = d.normalized_key)
  ),
  skipped as (
    select normalized_key from queue_existing
    union select normalized_key from history_existing
    union select normalized_key from team_existing
  ),
  inserted as (
    insert into public.businesses (
      workspace_id, import_batch_id, name, email, phone, website, domain, category, category_id, category_name,
      location, source, status, score, normalized_key, raw, created_by
    )
    select
      target_workspace, target_batch_id, d.name, d.email, d.phone, d.website, d.domain, d.category, d.category_id, d.category_name,
      d.location, d.source,
      case when coalesce(nullif(d.email, ''), '') <> '' then 'ready' else 'pending' end,
      case when coalesce(nullif(d.email, ''), '') <> '' then 75 else null end,
      d.normalized_key, d.raw, auth.uid()
    from deduped d
    where not exists (select 1 from skipped s where s.normalized_key = d.normalized_key)
    on conflict (workspace_id, normalized_key) do nothing
    returning normalized_key
  )
  select
    (select count(*)::int from inserted) as inserted_count,
    (select count(*)::int from queue_existing) as skipped_queue_count,
    (select count(*)::int from history_existing) as skipped_history_count,
    (select count(*)::int from team_existing) as skipped_team_count,
    coalesce((select array_agg(normalized_key) from skipped), array[]::text[]) as skipped_keys;
end;
$$;

grant execute on function public.import_businesses_chunk_with_category(uuid, uuid, jsonb, uuid, text) to authenticated;

-- Optional repair helper: removes duplicates already inserted into a workspace when another team workspace owned the prospect first.
create or replace function public.remove_team_duplicates_from_workspace(target_workspace uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  removed int := 0;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if not public.is_workspace_member(target_workspace) then
    raise exception 'User is not approved for this workspace';
  end if;

  delete from public.email_research_jobs j
  using public.businesses b, public.team_scouted_leads t
  where j.business_id = b.id
    and b.workspace_id = target_workspace
    and t.normalized_key = b.normalized_key
    and t.first_workspace_id is distinct from target_workspace
    and coalesce(b.status, '') not in ('contacted','responded');

  delete from public.businesses b
  using public.team_scouted_leads t
  where b.workspace_id = target_workspace
    and t.normalized_key = b.normalized_key
    and t.first_workspace_id is distinct from target_workspace
    and coalesce(b.status, '') not in ('contacted','responded');
  get diagnostics removed = row_count;

  if removed > 0 then
    insert into public.app_notifications (workspace_id, type, title, message, entity_type, entity_id, raw)
    values (
      target_workspace,
      'team_duplicate_removed',
      'Team duplicate leads removed',
      removed::text || ' lead' || case when removed = 1 then '' else 's' end || ' already scouted by a team member and removed from this account.',
      'team_duplicate_cleanup',
      target_workspace::text || '-' || extract(epoch from now())::text,
      jsonb_build_object('removed', removed, 'target_workspace', target_workspace)
    );
  end if;

  return removed;
end;
$$;

grant execute on function public.remove_team_duplicates_from_workspace(uuid) to authenticated;

-- Admin-only dashboard helpers.
create or replace function public.is_main_scout_admin()
returns boolean
language sql
security definer
set search_path = public, auth
as $$
  select exists (
    select 1 from auth.users u
    where u.id = auth.uid()
      and lower(coalesce(u.email, '')) = 'legacy-admin-disabled@invalid.local'
  );
$$;

grant execute on function public.is_main_scout_admin() to authenticated;

create or replace function public.admin_team_dashboard()
returns table(
  user_id uuid,
  user_email text,
  workspace_id uuid,
  workspace_name text,
  lifetime_sent bigint,
  connected_senders bigint,
  total_leads bigint,
  ready_leads bigint,
  real_replies bigint,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.is_main_scout_admin() then
    raise exception 'Only the main Scout admin can read Team Dashboard';
  end if;

  return query
  select
    wm.user_id,
    coalesce(u.email, p.email) as user_email,
    w.id as workspace_id,
    w.name as workspace_name,
    (select count(*) from public.sent_messages sm where sm.workspace_id = w.id and coalesce(sm.status, '') in ('sent','delivered')) as lifetime_sent,
    (select count(*) from public.gmail_accounts ga where ga.workspace_id = w.id and coalesce(ga.status, '') in ('connected','active','ready')) as connected_senders,
    (select count(*) from public.businesses b where b.workspace_id = w.id) as total_leads,
    (select count(*) from public.businesses b where b.workspace_id = w.id and coalesce(b.status, '') in ('ready','found')) as ready_leads,
    (select count(*) from public.reply_history r where r.workspace_id = w.id and coalesce(r.is_real_reply, false) = true) as real_replies,
    w.created_at
  from public.workspaces w
  left join lateral (
    select user_id, role
    from public.workspace_members wm2
    where wm2.workspace_id = w.id and wm2.approved = true
    order by case when wm2.role = 'admin' then 0 else 1 end, wm2.created_at asc
    limit 1
  ) wm on true
  left join auth.users u on u.id = wm.user_id
  left join public.profiles p on p.id = wm.user_id
  order by w.created_at desc;
end;
$$;

grant execute on function public.admin_team_dashboard() to authenticated;

create or replace function public.admin_team_sender_dashboard()
returns table(
  user_email text,
  workspace_id uuid,
  workspace_name text,
  sender_email text,
  lifetime_sent bigint,
  last_sent_at timestamptz
)
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.is_main_scout_admin() then
    raise exception 'Only the main Scout admin can read Team Dashboard';
  end if;

  return query
  select
    coalesce(u.email, p.email) as user_email,
    w.id as workspace_id,
    w.name as workspace_name,
    coalesce(nullif(lower(ga.email), ''), nullif(lower(sm.from_email), ''), 'unknown') as sender_email,
    count(sm.id) filter (where coalesce(sm.status, '') in ('sent','delivered')) as lifetime_sent,
    max(sm.sent_at) as last_sent_at
  from public.workspaces w
  left join lateral (
    select user_id
    from public.workspace_members wm2
    where wm2.workspace_id = w.id and wm2.approved = true
    order by case when wm2.role = 'admin' then 0 else 1 end, wm2.created_at asc
    limit 1
  ) wm on true
  left join auth.users u on u.id = wm.user_id
  left join public.profiles p on p.id = wm.user_id
  left join public.gmail_accounts ga on ga.workspace_id = w.id
  left join public.sent_messages sm on sm.workspace_id = w.id and (sm.gmail_account_id = ga.id or lower(sm.from_email) = lower(ga.email))
  where ga.id is not null or sm.id is not null
  group by coalesce(u.email, p.email), w.id, w.name, coalesce(nullif(lower(ga.email), ''), nullif(lower(sm.from_email), ''), 'unknown')
  order by lifetime_sent desc, sender_email asc;
end;
$$;

grant execute on function public.admin_team_sender_dashboard() to authenticated;

-- Keep the admin setup values available to user workspaces without sharing private leads/templates/senders.
do $$
declare
  admin_workspace uuid := '00000000-0000-4000-8000-000000000001';
  source_workspace public.workspaces%rowtype;
begin
  select * into source_workspace from public.workspaces where id = admin_workspace;
  if source_workspace.id is not null then
    update public.workspaces
    set app_url = source_workspace.app_url,
        render_backend_url = source_workspace.render_backend_url,
        dork_settings = coalesce(source_workspace.dork_settings, '{}'::jsonb),
        extension_settings = coalesce(source_workspace.extension_settings, '{}'::jsonb),
        updated_at = now()
    where id <> admin_workspace;
  end if;
end $$;

notify pgrst, 'reload schema';

-- <<< END SUPABASE_V10_30_TEAM_DUPLICATE_GUARD_ADMIN_DASHBOARD.sql

-- >>> BEGIN RUN_THIS_SQL_FIRST_V10_33_ACCESS_RECOVERY.sql
-- Scout v10.33 access recovery
-- Built against the live schema audit generated 2026-07-14.
-- Purpose:
--   * make legacy-admin-disabled@invalid.local the only global admin;
--   * remove manual approval as an access gate;
--   * repair missing profiles/workspaces/memberships for every Auth user;
--   * downgrade regular workspace memberships from admin to member;
--   * restore private per-workspace RLS;
--   * make Team Dashboard count Auth users and show only connected-account totals.
-- This migration does not delete businesses, messages, templates, replies, Gmail accounts, or sending history.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

alter table public.profiles
  add column if not exists full_name text;

-- The only global administrator is the exact email below.
create or replace function public.is_main_scout_admin()
returns boolean
language sql
stable
security definer
set search_path = public, auth
set row_security = off
as $$
  select exists (
    select 1
    from auth.users u
    where u.id = auth.uid()
      and lower(coalesce(u.email, '')) = 'legacy-admin-disabled@invalid.local'
  );
$$;

revoke all on function public.is_main_scout_admin() from public;
grant execute on function public.is_main_scout_admin() to authenticated, service_role;

-- A user belongs only to workspaces that have an explicit membership row.
-- "approved" remains for backward compatibility but is no longer an access gate.
create or replace function public.is_workspace_member(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
set row_security = off
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = target_workspace
      and wm.user_id = auth.uid()
  );
$$;

revoke all on function public.is_workspace_member(uuid) from public;
grant execute on function public.is_workspace_member(uuid) to authenticated, service_role;

-- Users may read only their own membership rows. Other workspace data continues
-- to use is_workspace_member(workspace_id), which now enforces real membership.
drop policy if exists "workspace members read own workspace" on public.workspace_members;
drop policy if exists "workspace members read own membership" on public.workspace_members;
create policy "workspace members read own membership"
on public.workspace_members
for select
to authenticated
using (user_id = auth.uid());

-- Internal idempotent provisioner. It is used by the signup trigger and by the
-- one-time repair block below. It is not callable by normal app users.
drop function if exists public.provision_scout_user(uuid);
create function public.provision_scout_user(p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, auth
set row_security = off
as $$
declare
  v_admin_email constant text := 'legacy-admin-disabled@invalid.local';
  v_admin_workspace constant uuid := '00000000-0000-4000-8000-000000000001';
  v_email text;
  v_full_name text;
  v_is_admin boolean;
  v_workspace_id uuid;
  v_app_url text;
  v_render_backend_url text;
  v_dork_settings jsonb;
  v_extension_settings jsonb;
begin
  select
    lower(coalesce(u.email, '')),
    nullif(trim(coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', '')), '')
  into v_email, v_full_name
  from auth.users u
  where u.id = p_user_id;

  if not found then
    raise exception 'Scout user % does not exist in auth.users', p_user_id;
  end if;

  v_is_admin := v_email = v_admin_email;

  insert into public.profiles (id, email, full_name, role, status)
  values (
    p_user_id,
    v_email,
    v_full_name,
    case when v_is_admin then 'admin' else 'member' end,
    'approved'
  )
  on conflict (id) do update
  set email = excluded.email,
      full_name = coalesce(excluded.full_name, public.profiles.full_name),
      role = excluded.role,
      status = 'approved',
      updated_at = now();

  -- Keep the existing admin workspace and its data/settings.
  insert into public.workspaces (id, name, owner_id)
  values (v_admin_workspace, 'Elevate Scout Team', case when v_is_admin then p_user_id else null end)
  on conflict (id) do update
  set owner_id = case
        when v_is_admin then p_user_id
        else public.workspaces.owner_id
      end,
      updated_at = now();

  if v_is_admin then
    v_workspace_id := v_admin_workspace;

    insert into public.workspace_members (workspace_id, user_id, role, approved)
    values (v_workspace_id, p_user_id, 'admin', true)
    on conflict (workspace_id, user_id) do update
    set role = 'admin', approved = true;

    -- The main admin remains the only admin role in the system.
    update public.workspace_members
    set role = 'member', approved = true
    where user_id = p_user_id
      and workspace_id <> v_admin_workspace
      and (role <> 'member' or approved is distinct from true);
  else
    -- Regular users must never inherit access to the admin workspace.
    delete from public.workspace_members
    where user_id = p_user_id
      and workspace_id = v_admin_workspace;

    -- Prefer an existing workspace already owned by this user so all existing
    -- businesses/messages/templates remain attached to the same workspace.
    select w.id
    into v_workspace_id
    from public.workspaces w
    where w.owner_id = p_user_id
      and w.id <> v_admin_workspace
    order by w.created_at asc
    limit 1;

    -- Recover an older owner-less personal workspace only when this user already
    -- has the membership. Never take ownership of another user's workspace.
    if v_workspace_id is null then
      select w.id
      into v_workspace_id
      from public.workspace_members wm
      join public.workspaces w on w.id = wm.workspace_id
      where wm.user_id = p_user_id
        and w.id <> v_admin_workspace
        and w.owner_id is null
      order by w.created_at asc
      limit 1;
    end if;

    if v_workspace_id is null then
      select
        w.app_url,
        w.render_backend_url,
        coalesce(w.dork_settings, '{}'::jsonb),
        coalesce(w.extension_settings, '{}'::jsonb)
      into v_app_url, v_render_backend_url, v_dork_settings, v_extension_settings
      from public.workspaces w
      where w.id = v_admin_workspace;

      insert into public.workspaces (
        name,
        owner_id,
        app_url,
        render_backend_url,
        dork_settings,
        extension_settings
      )
      values (
        'Scout Workspace - ' || coalesce(v_email, p_user_id::text),
        p_user_id,
        v_app_url,
        v_render_backend_url,
        coalesce(v_dork_settings, '{}'::jsonb),
        coalesce(v_extension_settings, '{}'::jsonb)
      )
      returning id into v_workspace_id;
    else
      update public.workspaces
      set owner_id = p_user_id,
          updated_at = now()
      where id = v_workspace_id
        and owner_id is null;
    end if;

    insert into public.workspace_members (workspace_id, user_id, role, approved)
    values (v_workspace_id, p_user_id, 'member', true)
    on conflict (workspace_id, user_id) do update
    set role = 'member', approved = true;

    -- Correct every historical regular-user membership that was wrongly marked admin.
    update public.workspace_members
    set role = 'member', approved = true
    where user_id = p_user_id
      and workspace_id <> v_admin_workspace
      and (role <> 'member' or approved is distinct from true);
  end if;

  return v_workspace_id;
end;
$$;

revoke all on function public.provision_scout_user(uuid) from public, anon, authenticated;
grant execute on function public.provision_scout_user(uuid) to service_role;

-- Future signups: create profile + private workspace + member role immediately.
-- The optional admin notification can fail without cancelling a valid signup.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth
set row_security = off
as $$
declare
  v_workspace_id uuid;
  v_full_name text := nullif(trim(coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', '')), '');
begin
  v_workspace_id := public.provision_scout_user(new.id);

  if lower(coalesce(new.email, '')) <> 'legacy-admin-disabled@invalid.local' then
    begin
      insert into public.app_notifications (
        workspace_id, type, title, message, entity_type, entity_id, raw
      )
      values (
        '00000000-0000-4000-8000-000000000001',
        'new_signup',
        'New Scout signup',
        case when v_full_name is not null
          then v_full_name || ' (' || coalesce(new.email, 'no email') || ') created a Scout account.'
          else coalesce(new.email, 'A new user') || ' created a Scout account.'
        end,
        'auth_user',
        new.id::text,
        jsonb_build_object(
          'name', v_full_name,
          'email', new.email,
          'user_id', new.id,
          'workspace_id', v_workspace_id
        )
      )
      on conflict do nothing;
    exception when others then
      raise warning 'Scout signup notification skipped: %', sqlerrm;
    end;
  end if;

  return new;
end;
$$;

-- Recreate the trigger explicitly so it points to the corrected function.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- Repair all existing Auth users once. This preserves valid existing workspaces
-- and creates only the three missing account workspaces found by the live audit.
do $$
declare
  r record;
begin
  for r in select id from auth.users order by created_at asc loop
    perform public.provision_scout_user(r.id);
  end loop;
end;
$$;

-- Read-only workspace resolver used by v10.33. It does not create or repair data.
drop function if exists public.current_scout_workspace();
create function public.current_scout_workspace()
returns table (
  id uuid,
  name text,
  api_key text,
  app_url text,
  render_backend_url text,
  default_audience_category_id uuid,
  default_audience_category_name text,
  dork_settings jsonb,
  extension_settings jsonb,
  email_signature_text text,
  email_signature_html text,
  email_logo_url text
)
language sql
stable
security definer
set search_path = public, auth
set row_security = off
as $$
  select
    w.id,
    w.name,
    w.api_key,
    w.app_url,
    w.render_backend_url,
    w.default_audience_category_id,
    w.default_audience_category_name,
    w.dork_settings,
    w.extension_settings,
    w.email_signature_text,
    w.email_signature_html,
    w.email_logo_url
  from public.workspace_members wm
  join public.workspaces w on w.id = wm.workspace_id
  join auth.users u on u.id = wm.user_id
  where wm.user_id = auth.uid()
  order by
    case
      when lower(coalesce(u.email, '')) = 'legacy-admin-disabled@invalid.local'
       and w.id = '00000000-0000-4000-8000-000000000001' then 0
      when w.owner_id = wm.user_id then 1
      else 2
    end,
    wm.created_at asc
  limit 1;
$$;

revoke all on function public.current_scout_workspace() from public, anon;
grant execute on function public.current_scout_workspace() to authenticated, service_role;

-- Team Dashboard now returns one row for every Auth account, not one row per
-- workspace. It exposes only the count of connected sender accounts.
drop function if exists public.admin_team_sender_dashboard();
drop function if exists public.admin_team_dashboard();

create function public.admin_team_dashboard()
returns table (
  user_id uuid,
  full_name text,
  user_email text,
  workspace_id uuid,
  workspace_name text,
  lifetime_sent bigint,
  connected_senders bigint,
  total_leads bigint,
  ready_leads bigint,
  real_replies bigint,
  auto_replies bigint,
  no_inbox_count bigint,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, auth
set row_security = off
as $$
begin
  if not public.is_main_scout_admin() then
    raise exception 'Only the main Scout admin can read Team Dashboard';
  end if;

  return query
  with account_workspace as (
    select
      u.id as user_id,
      (
        select w.id
        from public.workspace_members wm
        join public.workspaces w on w.id = wm.workspace_id
        where wm.user_id = u.id
        order by
          case
            when lower(coalesce(u.email, '')) = 'legacy-admin-disabled@invalid.local'
             and w.id = '00000000-0000-4000-8000-000000000001' then 0
            when w.owner_id = u.id then 1
            else 2
          end,
          wm.created_at asc
        limit 1
      ) as workspace_id
    from auth.users u
  )
  select
    u.id,
    coalesce(
      nullif(trim(p.full_name), ''),
      nullif(trim(u.raw_user_meta_data->>'full_name'), ''),
      nullif(trim(u.raw_user_meta_data->>'name'), ''),
      split_part(coalesce(u.email, ''), '@', 1)
    ) as full_name,
    u.email::text as user_email,
    w.id as workspace_id,
    w.name as workspace_name,
    coalesce((
      select count(*)
      from public.sent_messages sm
      where sm.workspace_id = w.id
        and coalesce(sm.status, '') in ('sent', 'delivered')
    ), 0)::bigint as lifetime_sent,
    coalesce((
      select count(*)
      from public.gmail_accounts ga
      where ga.workspace_id = w.id
        and coalesce(ga.status, '') in ('connected', 'active', 'ready')
    ), 0)::bigint as connected_senders,
    coalesce((
      select count(*) from public.businesses b where b.workspace_id = w.id
    ), 0)::bigint as total_leads,
    coalesce((
      select count(*)
      from public.businesses b
      where b.workspace_id = w.id
        and coalesce(b.status, '') in ('ready', 'found')
    ), 0)::bigint as ready_leads,
    coalesce((
      select count(*)
      from public.reply_history r
      where r.workspace_id = w.id
        and coalesce(r.is_real_reply, false) = true
    ), 0)::bigint as real_replies,
    coalesce((
      select count(*)
      from public.reply_history r
      where r.workspace_id = w.id
        and coalesce(r.is_auto_reply, false) = true
    ), 0)::bigint as auto_replies,
    coalesce((
      select count(*)
      from public.no_inbox_records n
      where n.workspace_id = w.id
    ), 0)::bigint as no_inbox_count,
    u.created_at
  from auth.users u
  left join public.profiles p on p.id = u.id
  left join account_workspace aw on aw.user_id = u.id
  left join public.workspaces w on w.id = aw.workspace_id
  order by u.created_at desc;
end;
$$;

revoke all on function public.admin_team_dashboard() from public, anon;
grant execute on function public.admin_team_dashboard() to authenticated, service_role;

-- app_notifications was unrestricted in the live audit. Restrict it to the
-- signed-in user's workspace while preserving all existing app operations.
alter table public.app_notifications enable row level security;
drop policy if exists "app notifications member select" on public.app_notifications;
drop policy if exists "app notifications member insert" on public.app_notifications;
drop policy if exists "app notifications member update" on public.app_notifications;
drop policy if exists "app notifications member delete" on public.app_notifications;
create policy "app notifications member select"
on public.app_notifications for select to authenticated
using (
  (workspace_id is not null and public.is_workspace_member(workspace_id))
  or user_id = auth.uid()
);
create policy "app notifications member insert"
on public.app_notifications for insert to authenticated
with check (
  (workspace_id is not null and public.is_workspace_member(workspace_id))
  or user_id = auth.uid()
);
create policy "app notifications member update"
on public.app_notifications for update to authenticated
using (
  (workspace_id is not null and public.is_workspace_member(workspace_id))
  or user_id = auth.uid()
)
with check (
  (workspace_id is not null and public.is_workspace_member(workspace_id))
  or user_id = auth.uid()
);
create policy "app notifications member delete"
on public.app_notifications for delete to authenticated
using (
  (workspace_id is not null and public.is_workspace_member(workspace_id))
  or user_id = auth.uid()
);


commit;

-- Verification result: this query should show exactly one admin profile, zero
-- missing profiles, zero missing memberships, and zero regular admin memberships.
select jsonb_build_object(
  'auth_users', (select count(*) from auth.users),
  'profiles', (select count(*) from public.profiles),
  'memberships', (select count(*) from public.workspace_members),
  'only_admin_email', (
    select jsonb_agg(p.email order by p.email)
    from public.profiles p
    where p.role = 'admin'
  ),
  'users_without_profile', (
    select count(*)
    from auth.users u
    left join public.profiles p on p.id = u.id
    where p.id is null
  ),
  'users_without_membership', (
    select count(*)
    from auth.users u
    where not exists (
      select 1 from public.workspace_members wm where wm.user_id = u.id
    )
  ),
  'regular_users_with_admin_membership', (
    select count(*)
    from public.workspace_members wm
    join auth.users u on u.id = wm.user_id
    where lower(coalesce(u.email, '')) <> 'legacy-admin-disabled@invalid.local'
      and wm.role = 'admin'
  )
) as scout_v10_33_recovery_result;

-- <<< END RUN_THIS_SQL_FIRST_V10_33_ACCESS_RECOVERY.sql

-- >>> BEGIN 202607170900_v10_36_adaptive_free.sql
-- Scout v10.36 Fresh Adaptive Free
-- Safe to run after the bundled historical migrations. Fresh installations use database/01_FRESH_INSTALL.sql.

create extension if not exists pgcrypto;

alter table if exists public.gmail_accounts add column if not exists deployment_cap integer not null default 100;
alter table if exists public.gmail_accounts add column if not exists deployment_run_cap integer not null default 50;
alter table if exists public.gmail_accounts add column if not exists health_stage text not null default 'assessment';
alter table if exists public.gmail_accounts add column if not exists health_cap integer not null default 25;
alter table if exists public.gmail_accounts add column if not exists health_reason text;
alter table if exists public.gmail_accounts add column if not exists successful_sends bigint not null default 0;
alter table if exists public.gmail_accounts add column if not exists lifetime_sent bigint not null default 0;
alter table if exists public.gmail_accounts add column if not exists permanent_bounces bigint not null default 0;
alter table if exists public.gmail_accounts add column if not exists temporary_failures bigint not null default 0;
alter table if exists public.gmail_accounts add column if not exists provider_limit_events bigint not null default 0;
alter table if exists public.gmail_accounts add column if not exists blocked_events bigint not null default 0;
alter table if exists public.gmail_accounts add column if not exists real_replies bigint not null default 0;
alter table if exists public.gmail_accounts add column if not exists last_provider_limit_at timestamptz;
alter table if exists public.gmail_accounts add column if not exists clean_since timestamptz not null default now();
alter table if exists public.gmail_accounts add column if not exists next_eligible_at timestamptz;
alter table if exists public.gmail_accounts add column if not exists last_sent_at timestamptz;
alter table if exists public.gmail_accounts add column if not exists last_health_review_at timestamptz;
alter table if exists public.gmail_accounts add column if not exists is_paused boolean not null default false;
alter table if exists public.gmail_accounts add column if not exists paused_reason text;

update public.gmail_accounts
set deployment_cap = greatest(1, least(300, coalesce(deployment_cap, 100))),
    deployment_run_cap = greatest(1, least(coalesce(deployment_cap, 100), coalesce(deployment_run_cap, 50))),
    daily_limit = greatest(1, least(coalesce(deployment_cap, 100), coalesce(daily_limit, deployment_cap, 100))),
    default_run_limit = greatest(1, least(coalesce(deployment_cap, 100), coalesce(default_run_limit, 50))),
    health_stage = coalesce(nullif(health_stage, ''), 'assessment'),
    health_cap = case
      when coalesce(successful_sends, 0) < 25 then least(coalesce(deployment_cap, 100), 25)
      when coalesce(successful_sends, 0) < 50 then least(coalesce(deployment_cap, 100), 50)
      when coalesce(successful_sends, 0) < 100 then least(coalesce(deployment_cap, 100), 100)
      when coalesce(successful_sends, 0) < 150 then least(coalesce(deployment_cap, 100), 150)
      else coalesce(deployment_cap, 100)
    end;

alter table if exists public.businesses add column if not exists email_verification_status text not null default 'unchecked';
alter table if exists public.businesses add column if not exists email_verification_level text;
alter table if exists public.businesses add column if not exists email_verified_at timestamptz;
alter table if exists public.businesses add column if not exists email_verification_reason text;
alter table if exists public.businesses add column if not exists email_role_label text;
alter table if exists public.businesses add column if not exists email_mx_hosts text[] not null default '{}';

create table if not exists public.email_verifications (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null,
  domain text not null,
  status text not null,
  verification_level text not null default 'basic',
  syntax_valid boolean not null default false,
  domain_has_mx boolean not null default false,
  mx_hosts text[] not null default '{}',
  role_inbox boolean not null default false,
  role_label text,
  disposable boolean not null default false,
  reason text,
  checked_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  raw jsonb not null default '{}'::jsonb,
  primary key (workspace_id, email)
);

create index if not exists email_verifications_status_idx on public.email_verifications(workspace_id, status, expires_at);

create table if not exists public.sender_health_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  gmail_account_id uuid not null references public.gmail_accounts(id) on delete cascade,
  event_type text not null,
  reason text,
  recipient_email text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists sender_health_events_account_time_idx
on public.sender_health_events(gmail_account_id, created_at desc);
create index if not exists sender_health_events_workspace_time_idx
on public.sender_health_events(workspace_id, created_at desc);

create table if not exists public.sender_send_reservations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  gmail_account_id uuid not null references public.gmail_accounts(id) on delete cascade,
  status text not null default 'reserved',
  effective_daily_limit integer not null,
  used_before integer not null default 0,
  reason text,
  dispatch_at timestamptz not null default now(),
  reserved_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  finalized_at timestamptz,
  released_at timestamptz,
  raw jsonb not null default '{}'::jsonb
);

create index if not exists sender_reservations_account_time_idx
on public.sender_send_reservations(gmail_account_id, reserved_at desc);
create index if not exists sender_reservations_active_idx
on public.sender_send_reservations(gmail_account_id, status, expires_at);

create table if not exists public.workspace_dispatch_state (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  next_dispatch_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.email_verifications enable row level security;
alter table public.sender_health_events enable row level security;
alter table public.sender_send_reservations enable row level security;
alter table public.workspace_dispatch_state enable row level security;

-- Verification results are isolated by workspace and contain no message bodies or OAuth secrets.
drop policy if exists email_verifications_authenticated_read on public.email_verifications;
drop policy if exists email_verifications_member_read on public.email_verifications;
create policy email_verifications_member_read on public.email_verifications
for select to authenticated using (public.is_workspace_member(workspace_id));

-- Writes are performed by server routes with the service-role key.
drop policy if exists sender_health_events_member_read on public.sender_health_events;
create policy sender_health_events_member_read on public.sender_health_events
for select to authenticated using (public.is_workspace_member(workspace_id));

drop policy if exists sender_reservations_member_read on public.sender_send_reservations;
create policy sender_reservations_member_read on public.sender_send_reservations
for select to authenticated using (public.is_workspace_member(workspace_id));

create or replace function public.reserve_sender_send(
  target_workspace uuid,
  target_account uuid,
  reservation_raw jsonb default '{}'::jsonb
)
returns table(
  allowed boolean,
  reservation_id uuid,
  reason text,
  effective_daily_limit integer,
  used_last_24h integer,
  remaining integer,
  dispatch_at timestamptz,
  next_eligible_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  a public.gmail_accounts%rowtype;
  deployment_limit integer;
  health_limit integer;
  user_limit integer;
  effective_limit integer;
  checkpoint_limit integer;
  used_count integer;
  new_reservation uuid;
  dispatch_time timestamptz;
  workspace_next timestamptz;
  next_time timestamptz;
begin
  select * into a
  from public.gmail_accounts
  where id = target_account and workspace_id = target_workspace
  for update;

  if not found then
    return query select false, null::uuid, 'Sender account was not found.', 0, 0, 0, null::timestamptz, null::timestamptz;
    return;
  end if;

  deployment_limit := greatest(1, least(300, coalesce(a.deployment_cap, 100)));
  checkpoint_limit := case
    when coalesce(a.successful_sends, 0) < 25 then least(deployment_limit, 25)
    when coalesce(a.successful_sends, 0) < 50 then least(deployment_limit, 50)
    when coalesce(a.successful_sends, 0) < 100 then least(deployment_limit, 100)
    when coalesce(a.successful_sends, 0) < 150 then least(deployment_limit, 150)
    else deployment_limit
  end;

  health_limit := case lower(coalesce(a.health_stage, 'assessment'))
    when 'assessment' then checkpoint_limit
    when 'restricted' then least(deployment_limit, 50)
    when 'recovering' then least(deployment_limit, 75)
    when 'stable' then least(deployment_limit, 100)
    when 'established' then least(deployment_limit, 150)
    when 'healthy' then least(deployment_limit, 200)
    when 'proven' then deployment_limit
    when 'paused' then 0
    else checkpoint_limit
  end;
  health_limit := least(health_limit, greatest(0, coalesce(a.health_cap, health_limit)));
  user_limit := greatest(1, least(deployment_limit, coalesce(a.daily_limit, deployment_limit)));
  effective_limit := greatest(0, least(deployment_limit, health_limit, user_limit));

  select count(*)::integer into used_count
  from public.sender_send_reservations r
  where r.workspace_id = target_workspace
    and r.gmail_account_id = target_account
    and (
      (r.status = 'sent' and r.finalized_at >= now() - interval '24 hours')
      or (r.status = 'reserved' and r.expires_at > now())
    );

  if coalesce(a.is_paused, false)
     or lower(coalesce(a.status, '')) in ('paused', 'limit_hit', 'blocked', 'error')
     or (a.paused_until is not null and a.paused_until > now()) then
    return query select false, null::uuid,
      coalesce(a.paused_reason, a.last_error, 'Sender is paused.'),
      effective_limit, used_count, greatest(0, effective_limit - used_count), null::timestamptz, a.next_eligible_at;
    return;
  end if;

  if a.next_eligible_at is not null and a.next_eligible_at > now() then
    return query select false, null::uuid, 'Sender cooldown is still active.',
      effective_limit, used_count, greatest(0, effective_limit - used_count), null::timestamptz, a.next_eligible_at;
    return;
  end if;

  if effective_limit <= 0 or used_count >= effective_limit then
    return query select false, null::uuid, 'Sender reached its effective rolling 24-hour limit.',
      effective_limit, used_count, greatest(0, effective_limit - used_count), null::timestamptz, a.next_eligible_at;
    return;
  end if;

  insert into public.workspace_dispatch_state(workspace_id, next_dispatch_at)
  values (target_workspace, now())
  on conflict (workspace_id) do nothing;

  select s.next_dispatch_at into workspace_next
  from public.workspace_dispatch_state s
  where s.workspace_id = target_workspace
  for update;

  dispatch_time := greatest(now(), coalesce(workspace_next, now()));
  if dispatch_time > now() + interval '45 seconds' then
    return query select false, null::uuid,
      'Workspace dispatch slots are full for this cron cycle. Scout will retry automatically.',
      effective_limit, used_count, greatest(0, effective_limit - used_count), dispatch_time, a.next_eligible_at;
    return;
  end if;

  update public.workspace_dispatch_state
  set next_dispatch_at = dispatch_time + interval '5 seconds', updated_at = now()
  where workspace_id = target_workspace;

  next_time := dispatch_time + make_interval(secs => (90 + floor(random() * 121))::integer);
  insert into public.sender_send_reservations(
    workspace_id, gmail_account_id, status, effective_daily_limit, used_before, dispatch_at, expires_at, raw
  ) values (
    target_workspace, target_account, 'reserved', effective_limit, used_count, dispatch_time,
    dispatch_time + interval '10 minutes', coalesce(reservation_raw, '{}'::jsonb)
  ) returning id into new_reservation;

  update public.gmail_accounts
  set next_eligible_at = next_time,
      health_cap = health_limit,
      updated_at = now()
  where id = target_account and workspace_id = target_workspace;

  return query select true, new_reservation, 'Reserved.', effective_limit, used_count,
    greatest(0, effective_limit - used_count - 1), dispatch_time, next_time;
end;
$$;

create or replace function public.finalize_sender_send(
  target_reservation uuid,
  target_recipient text default null,
  event_raw jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.sender_send_reservations%rowtype;
begin
  update public.sender_send_reservations
  set status = 'sent', finalized_at = now(), raw = coalesce(raw, '{}'::jsonb) || coalesce(event_raw, '{}'::jsonb)
  where id = target_reservation and status = 'reserved'
  returning * into r;

  if not found then return false; end if;

  update public.gmail_accounts
  set successful_sends = coalesce(successful_sends, 0) + 1,
      lifetime_sent = coalesce(lifetime_sent, 0) + 1,
      sent_today = coalesce(sent_today, 0) + 1,
      last_sent_at = now(),
      last_error = null,
      updated_at = now()
  where id = r.gmail_account_id and workspace_id = r.workspace_id;

  insert into public.sender_health_events(
    workspace_id, gmail_account_id, event_type, recipient_email, raw
  ) values (
    r.workspace_id, r.gmail_account_id, 'send_success', nullif(lower(trim(target_recipient)), ''), coalesce(event_raw, '{}'::jsonb)
  );
  return true;
end;
$$;

create or replace function public.release_sender_send(
  target_reservation uuid,
  release_reason text default null,
  event_raw jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.sender_send_reservations%rowtype;
begin
  update public.sender_send_reservations
  set status = 'released', released_at = now(), reason = release_reason,
      raw = coalesce(raw, '{}'::jsonb) || coalesce(event_raw, '{}'::jsonb)
  where id = target_reservation and status = 'reserved'
  returning * into r;
  if not found then return false; end if;
  return true;
end;
$$;

create or replace function public.refresh_sender_today_counts()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  changed integer;
begin
  update public.gmail_accounts a
  set sent_today = coalesce(x.cnt, 0), updated_at = now()
  from (
    select ga.id,
      count(r.id) filter (where r.status = 'sent' and r.finalized_at >= date_trunc('day', now()))::integer as cnt
    from public.gmail_accounts ga
    left join public.sender_send_reservations r on r.gmail_account_id = ga.id
    group by ga.id
  ) x
  where a.id = x.id and a.sent_today is distinct from coalesce(x.cnt, 0);
  get diagnostics changed = row_count;
  return changed;
end;
$$;

revoke all on function public.reserve_sender_send(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.finalize_sender_send(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.release_sender_send(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.refresh_sender_today_counts() from public, anon, authenticated;
grant execute on function public.reserve_sender_send(uuid, uuid, jsonb) to service_role;
grant execute on function public.finalize_sender_send(uuid, text, jsonb) to service_role;
grant execute on function public.release_sender_send(uuid, text, jsonb) to service_role;
grant execute on function public.refresh_sender_today_counts() to service_role;

notify pgrst, 'reload schema';

-- Fresh-deployment ownership: the first person who signs up becomes the installation owner.
-- This makes the same ZIP deployable by different team members without editing a hard-coded email in SQL.
create table if not exists public.scout_installation (
  singleton boolean primary key default true check (singleton),
  owner_user_id uuid references auth.users(id) on delete set null,
  owner_email text,
  installed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
insert into public.scout_installation(singleton) values (true) on conflict (singleton) do nothing;

create or replace function public.is_main_scout_admin()
returns boolean
language sql
stable
security definer
set search_path = public, auth
set row_security = off
as $$
  select exists (
    select 1 from public.scout_installation i
    where i.singleton = true and i.owner_user_id = auth.uid()
  );
$$;
revoke all on function public.is_main_scout_admin() from public, anon;
grant execute on function public.is_main_scout_admin() to authenticated, service_role;

create or replace function public.provision_scout_user(p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, auth
set row_security = off
as $$
declare
  v_admin_workspace constant uuid := '00000000-0000-4000-8000-000000000001';
  v_email text;
  v_full_name text;
  v_owner_user_id uuid;
  v_is_owner boolean;
  v_workspace_id uuid;
  v_admin_source public.workspaces%rowtype;
begin
  select lower(coalesce(u.email, '')),
         nullif(trim(coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', '')), '')
  into v_email, v_full_name
  from auth.users u where u.id = p_user_id;
  if not found then raise exception 'Scout user % does not exist in auth.users', p_user_id; end if;

  perform pg_advisory_xact_lock(hashtext('scout_installation_owner'));
  insert into public.scout_installation(singleton) values (true) on conflict (singleton) do nothing;
  select owner_user_id into v_owner_user_id from public.scout_installation where singleton = true for update;
  if v_owner_user_id is null then
    update public.scout_installation
    set owner_user_id = p_user_id, owner_email = v_email, updated_at = now()
    where singleton = true;
    v_owner_user_id := p_user_id;
  end if;
  v_is_owner := v_owner_user_id = p_user_id;

  insert into public.profiles(id, email, full_name, role, status)
  values (p_user_id, v_email, v_full_name, case when v_is_owner then 'admin' else 'member' end, 'approved')
  on conflict (id) do update
  set email = excluded.email,
      full_name = coalesce(excluded.full_name, public.profiles.full_name),
      role = excluded.role,
      status = 'approved',
      updated_at = now();

  insert into public.workspaces(id, name, owner_id)
  values (v_admin_workspace, 'Scout Administration', case when v_is_owner then p_user_id else null end)
  on conflict (id) do update
  set owner_id = case when v_is_owner then p_user_id else public.workspaces.owner_id end,
      updated_at = now();

  if v_is_owner then
    v_workspace_id := v_admin_workspace;
    insert into public.workspace_members(workspace_id, user_id, role, approved)
    values (v_workspace_id, p_user_id, 'admin', true)
    on conflict (workspace_id, user_id) do update set role = 'admin', approved = true;
  else
    delete from public.workspace_members where user_id = p_user_id and workspace_id = v_admin_workspace;

    select w.id into v_workspace_id
    from public.workspaces w
    where w.owner_id = p_user_id and w.id <> v_admin_workspace
    order by w.created_at asc limit 1;

    if v_workspace_id is null then
      select * into v_admin_source from public.workspaces where id = v_admin_workspace;
      insert into public.workspaces(
        name, owner_id, app_url, render_backend_url,
        default_audience_category_id, default_audience_category_name,
        dork_settings, extension_settings
      ) values (
        'Scout Workspace - ' || coalesce(v_email, p_user_id::text),
        p_user_id,
        v_admin_source.app_url,
        v_admin_source.render_backend_url,
        v_admin_source.default_audience_category_id,
        v_admin_source.default_audience_category_name,
        coalesce(v_admin_source.dork_settings, '{}'::jsonb),
        coalesce(v_admin_source.extension_settings, '{}'::jsonb)
      ) returning id into v_workspace_id;
    end if;

    insert into public.workspace_members(workspace_id, user_id, role, approved)
    values (v_workspace_id, p_user_id, 'member', true)
    on conflict (workspace_id, user_id) do update set role = 'member', approved = true;
  end if;

  return v_workspace_id;
end;
$$;
revoke all on function public.provision_scout_user(uuid) from public, anon, authenticated;
grant execute on function public.provision_scout_user(uuid) to service_role;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth
set row_security = off
as $$
declare
  v_workspace_id uuid;
  v_owner_user_id uuid;
  v_full_name text := nullif(trim(coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', '')), '');
begin
  v_workspace_id := public.provision_scout_user(new.id);
  select owner_user_id into v_owner_user_id from public.scout_installation where singleton = true;
  if new.id is distinct from v_owner_user_id then
    begin
      insert into public.app_notifications(
        workspace_id, type, title, message, entity_type, entity_id, raw
      ) values (
        '00000000-0000-4000-8000-000000000001',
        'new_signup',
        'New Scout signup',
        case when v_full_name is not null
          then v_full_name || ' (' || coalesce(new.email, 'no email') || ') created a Scout account.'
          else coalesce(new.email, 'A new user') || ' created a Scout account.' end,
        'auth_user', new.id::text,
        jsonb_build_object('name', v_full_name, 'email', new.email, 'user_id', new.id, 'workspace_id', v_workspace_id)
      ) on conflict do nothing;
    exception when others then
      raise warning 'Scout signup notification skipped: %', sqlerrm;
    end;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.current_scout_workspace()
returns table (
  id uuid,
  name text,
  api_key text,
  app_url text,
  render_backend_url text,
  default_audience_category_id uuid,
  default_audience_category_name text,
  dork_settings jsonb,
  extension_settings jsonb,
  email_signature_text text,
  email_signature_html text,
  email_logo_url text
)
language sql
stable
security definer
set search_path = public, auth
set row_security = off
as $$
  select w.id, w.name, w.api_key, w.app_url, w.render_backend_url,
         w.default_audience_category_id, w.default_audience_category_name,
         w.dork_settings, w.extension_settings,
         w.email_signature_text, w.email_signature_html, w.email_logo_url
  from public.workspace_members wm
  join public.workspaces w on w.id = wm.workspace_id
  left join public.scout_installation i on i.singleton = true
  where wm.user_id = auth.uid()
  order by
    case when i.owner_user_id = wm.user_id and w.id = '00000000-0000-4000-8000-000000000001' then 0
         when w.owner_id = wm.user_id then 1 else 2 end,
    wm.created_at asc
  limit 1;
$$;
revoke all on function public.current_scout_workspace() from public, anon;
grant execute on function public.current_scout_workspace() to authenticated, service_role;

-- If this migration is applied to an installation that already has users but no owner record,
-- the earliest Auth account becomes owner and all accounts are re-provisioned without deleting data.
do $$
declare
  v_first uuid;
  r record;
begin
  if (select owner_user_id is null from public.scout_installation where singleton = true) then
    select id into v_first from auth.users order by created_at asc limit 1;
    if v_first is not null then
      update public.scout_installation i
      set owner_user_id = v_first,
          owner_email = (select lower(email) from auth.users where id = v_first),
          updated_at = now()
      where i.singleton = true;
    end if;
  end if;
  for r in select id from auth.users order by created_at asc loop
    perform public.provision_scout_user(r.id);
  end loop;
end $$;

notify pgrst, 'reload schema';

-- <<< END 202607170900_v10_36_adaptive_free.sql

select pg_notify('pgrst', 'reload schema');

-- >>> BEGIN v10.36.2 SIMPLE INDEPENDENT DEPLOYMENT
-- Every account has equal access to its own private workspace. There is no global
-- administrator, no approval gate and no special owner email.
begin;

create or replace function public.is_main_scout_admin()
returns boolean
language sql
stable
security definer
set search_path = public, auth
set row_security = off
as $$ select false; $$;
revoke all on function public.is_main_scout_admin() from public, anon;
grant execute on function public.is_main_scout_admin() to authenticated, service_role;

drop function if exists public.admin_team_sender_dashboard();
drop function if exists public.admin_team_dashboard();

create or replace function public.provision_scout_user(p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, auth
set row_security = off
as $$
declare
  v_email text;
  v_full_name text;
  v_workspace_id uuid;
begin
  select lower(coalesce(u.email, '')),
         nullif(trim(coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', '')), '')
  into v_email, v_full_name
  from auth.users u
  where u.id = p_user_id;

  if not found then
    raise exception 'Scout user % does not exist in auth.users', p_user_id;
  end if;

  insert into public.profiles(id, email, full_name, role, status)
  values (p_user_id, v_email, v_full_name, 'member', 'approved')
  on conflict (id) do update
  set email = excluded.email,
      full_name = coalesce(excluded.full_name, public.profiles.full_name),
      role = 'member',
      status = 'approved',
      updated_at = now();

  select w.id into v_workspace_id
  from public.workspaces w
  where w.owner_id = p_user_id
  order by w.created_at asc
  limit 1;

  if v_workspace_id is null then
    select w.id into v_workspace_id
    from public.workspace_members wm
    join public.workspaces w on w.id = wm.workspace_id
    where wm.user_id = p_user_id
      and (w.owner_id is null or w.owner_id = p_user_id)
    order by wm.created_at asc
    limit 1;
  end if;

  if v_workspace_id is null then
    insert into public.workspaces(name, owner_id)
    values ('Scout - ' || coalesce(v_full_name, nullif(v_email, ''), p_user_id::text), p_user_id)
    returning id into v_workspace_id;
  else
    update public.workspaces
    set owner_id = p_user_id,
        updated_at = now()
    where id = v_workspace_id
      and owner_id is null;
  end if;

  insert into public.workspace_members(workspace_id, user_id, role, approved)
  values (v_workspace_id, p_user_id, 'member', true)
  on conflict (workspace_id, user_id) do update
  set role = 'member', approved = true;

  update public.workspace_members
  set role = 'member', approved = true
  where user_id = p_user_id;

  return v_workspace_id;
end;
$$;
revoke all on function public.provision_scout_user(uuid) from public, anon, authenticated;
grant execute on function public.provision_scout_user(uuid) to service_role;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth
set row_security = off
as $$
begin
  perform public.provision_scout_user(new.id);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.current_scout_workspace()
returns table (
  id uuid,
  name text,
  api_key text,
  app_url text,
  render_backend_url text,
  default_audience_category_id uuid,
  default_audience_category_name text,
  dork_settings jsonb,
  extension_settings jsonb,
  email_signature_text text,
  email_signature_html text,
  email_logo_url text
)
language sql
stable
security definer
set search_path = public, auth
set row_security = off
as $$
  select w.id, w.name, w.api_key, w.app_url, w.render_backend_url,
         w.default_audience_category_id, w.default_audience_category_name,
         w.dork_settings, w.extension_settings,
         w.email_signature_text, w.email_signature_html, w.email_logo_url
  from public.workspace_members wm
  join public.workspaces w on w.id = wm.workspace_id
  where wm.user_id = auth.uid()
  order by case when w.owner_id = wm.user_id then 0 else 1 end, wm.created_at asc
  limit 1;
$$;
revoke all on function public.current_scout_workspace() from public, anon;
grant execute on function public.current_scout_workspace() to authenticated, service_role;

update public.profiles set role = 'member', status = 'approved', updated_at = now();
update public.workspace_members set role = 'member', approved = true;

do $$
declare r record;
begin
  for r in select id from auth.users order by created_at asc loop
    perform public.provision_scout_user(r.id);
  end loop;
end $$;

commit;
notify pgrst, 'reload schema';
-- <<< END v10.36.2 SIMPLE INDEPENDENT DEPLOYMENT

-- v10.36.2 fixed sender defaults for every independent deployment.
alter table if exists public.gmail_accounts alter column deployment_cap set default 250;
alter table if exists public.gmail_accounts alter column deployment_run_cap set default 250;
alter table if exists public.gmail_accounts alter column daily_limit set default 250;
alter table if exists public.gmail_accounts alter column default_run_limit set default 250;

update public.gmail_accounts
set deployment_cap = 250,
    deployment_run_cap = 250,
    daily_limit = greatest(1, least(250, coalesce(daily_limit, 250))),
    default_run_limit = greatest(1, least(250, coalesce(default_run_limit, 250))),
    health_cap = greatest(0, least(250, coalesce(health_cap, 25))),
    updated_at = now();

notify pgrst, 'reload schema';

-- v10.36.7 installer repair: table-returning RPCs are safely dropped before replacement.

-- >>> BEGIN SCOUT_V10_37_FINAL_FIRST_INSTALL_PATCH
-- Final first-install rules: 250 hard ceiling, protected temporary safety resume,
-- 90–210 seconds between sends from the same Gmail and 3–6 seconds between
-- different Gmail accounts in the same workspace.

alter table if exists public.gmail_accounts add column if not exists pause_kind text;
alter table if exists public.gmail_accounts add column if not exists safety_override_until timestamptz;
alter table if exists public.gmail_accounts add column if not exists safety_override_warning text;
alter table if exists public.gmail_accounts add column if not exists safety_override_acknowledged_at timestamptz;
alter table if exists public.gmail_accounts add column if not exists last_stage_change_at timestamptz;

alter table if exists public.gmail_accounts alter column deployment_cap set default 250;
alter table if exists public.gmail_accounts alter column deployment_run_cap set default 250;

update public.gmail_accounts
set deployment_cap = 250,
    deployment_run_cap = 250,
    daily_limit = greatest(1, least(250, coalesce(daily_limit, 250))),
    default_run_limit = greatest(1, least(250, coalesce(default_run_limit, 50))),
    health_cap = greatest(0, least(250, coalesce(health_cap, 25))),
    updated_at = now();

drop function if exists public.reserve_sender_send(uuid, uuid, jsonb);

create function public.reserve_sender_send(
  target_workspace uuid,
  target_account uuid,
  reservation_raw jsonb default '{}'::jsonb
)
returns table(
  allowed boolean,
  reservation_id uuid,
  reason text,
  effective_daily_limit integer,
  used_last_24h integer,
  remaining integer,
  dispatch_at timestamptz,
  next_eligible_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  a public.gmail_accounts%rowtype;
  deployment_limit integer;
  health_limit integer;
  user_limit integer;
  effective_limit integer;
  checkpoint_limit integer;
  used_count integer;
  new_reservation uuid;
  dispatch_time timestamptz;
  workspace_next timestamptz;
  next_time timestamptz;
  workspace_gap_seconds integer;
  override_active boolean;
  automatic_pause boolean;
  timed_pause_expired boolean;
begin
  select * into a
  from public.gmail_accounts
  where id = target_account and workspace_id = target_workspace
  for update;

  if not found then
    return query select false, null::uuid, 'Sender account was not found.', 0, 0, 0, null::timestamptz, null::timestamptz;
    return;
  end if;

  deployment_limit := 250;
  override_active := coalesce(a.pause_kind, '') <> ''
    and coalesce(a.pause_kind, '') <> 'manual'
    and a.safety_override_until is not null
    and a.safety_override_until > now();
  automatic_pause := coalesce(a.pause_kind, '') <> '' and coalesce(a.pause_kind, '') <> 'manual';
  timed_pause_expired := automatic_pause
    and coalesce(a.pause_kind, '') <> 'permanent_bounce'
    and a.paused_until is not null
    and a.paused_until <= now();

  -- Timed automatic pauses recover automatically. Permanent-bounce and manual
  -- pauses require a person to act. Temporary override never deletes the warning.
  if timed_pause_expired and not override_active then
    update public.gmail_accounts
    set is_paused = false,
        status = 'connected',
        pause_kind = null,
        paused_until = null,
        paused_reason = null,
        safety_override_until = null,
        safety_override_warning = null,
        health_stage = 'recovering',
        health_cap = least(deployment_limit, 75),
        health_reason = 'The timed safety pause ended. Scout restarted this sender in Recovering stage.',
        updated_at = now()
    where id = target_account and workspace_id = target_workspace
    returning * into a;
    automatic_pause := false;
  elsif automatic_pause and not override_active then
    update public.gmail_accounts
    set is_paused = true,
        status = case when pause_kind = 'provider_limit' then 'limit_hit' else 'paused' end,
        safety_override_until = null,
        updated_at = now()
    where id = target_account and workspace_id = target_workspace
    returning * into a;
  end if;

  checkpoint_limit := case
    when coalesce(a.successful_sends, 0) < 25 then least(deployment_limit, 25)
    when coalesce(a.successful_sends, 0) < 50 then least(deployment_limit, 50)
    when coalesce(a.successful_sends, 0) < 100 then least(deployment_limit, 100)
    when coalesce(a.successful_sends, 0) < 150 then least(deployment_limit, 150)
    else deployment_limit
  end;

  health_limit := case lower(coalesce(a.health_stage, 'assessment'))
    when 'assessment' then checkpoint_limit
    when 'restricted' then least(deployment_limit, 50)
    when 'recovering' then least(deployment_limit, 75)
    when 'stable' then least(deployment_limit, 100)
    when 'established' then least(deployment_limit, 150)
    when 'healthy' then least(deployment_limit, 200)
    when 'proven' then deployment_limit
    when 'paused' then case when override_active then least(deployment_limit, 50) else 0 end
    else checkpoint_limit
  end;
  health_limit := least(health_limit, greatest(0, coalesce(a.health_cap, health_limit)));
  if override_active then health_limit := least(deployment_limit, greatest(1, least(50, health_limit))); end if;
  user_limit := greatest(1, least(deployment_limit, coalesce(a.daily_limit, deployment_limit)));
  effective_limit := greatest(0, least(deployment_limit, health_limit, user_limit));

  select count(*)::integer into used_count
  from public.sender_send_reservations r
  where r.workspace_id = target_workspace
    and r.gmail_account_id = target_account
    and (
      (r.status = 'sent' and r.finalized_at >= now() - interval '24 hours')
      or (r.status = 'reserved' and r.expires_at > now())
    );

  if coalesce(a.pause_kind, '') = 'manual' or (coalesce(a.is_paused, false) and not override_active)
     or (lower(coalesce(a.status, '')) in ('paused', 'limit_hit', 'blocked', 'error') and not override_active)
     or (automatic_pause and not override_active) then
    return query select false, null::uuid,
      coalesce(a.paused_reason, a.health_reason, a.last_error, 'Sender is paused.'),
      effective_limit, used_count, greatest(0, effective_limit - used_count), null::timestamptz, a.next_eligible_at;
    return;
  end if;

  if a.next_eligible_at is not null and a.next_eligible_at > now() then
    return query select false, null::uuid, 'Sender cooldown is still active.',
      effective_limit, used_count, greatest(0, effective_limit - used_count), null::timestamptz, a.next_eligible_at;
    return;
  end if;

  if effective_limit <= 0 or used_count >= effective_limit then
    return query select false, null::uuid, 'Sender reached its effective rolling 24-hour limit.',
      effective_limit, used_count, greatest(0, effective_limit - used_count), null::timestamptz, a.next_eligible_at;
    return;
  end if;

  insert into public.workspace_dispatch_state(workspace_id, next_dispatch_at)
  values (target_workspace, now())
  on conflict (workspace_id) do nothing;

  select s.next_dispatch_at into workspace_next
  from public.workspace_dispatch_state s
  where s.workspace_id = target_workspace
  for update;

  dispatch_time := greatest(now(), coalesce(workspace_next, now()));
  if dispatch_time > now() + interval '45 seconds' then
    return query select false, null::uuid,
      'Workspace dispatch slots are full for this worker cycle. Scout will retry automatically.',
      effective_limit, used_count, greatest(0, effective_limit - used_count), dispatch_time, a.next_eligible_at;
    return;
  end if;

  workspace_gap_seconds := 3 + floor(random() * 4)::integer;
  update public.workspace_dispatch_state
  set next_dispatch_at = dispatch_time + make_interval(secs => workspace_gap_seconds), updated_at = now()
  where workspace_id = target_workspace;

  next_time := dispatch_time + make_interval(secs => (90 + floor(random() * 121))::integer);
  insert into public.sender_send_reservations(
    workspace_id, gmail_account_id, status, effective_daily_limit, used_before, dispatch_at, expires_at, raw
  ) values (
    target_workspace, target_account, 'reserved', effective_limit, used_count, dispatch_time,
    dispatch_time + interval '10 minutes', coalesce(reservation_raw, '{}'::jsonb)
  ) returning id into new_reservation;

  update public.gmail_accounts
  set next_eligible_at = next_time,
      health_cap = health_limit,
      updated_at = now()
  where id = target_account and workspace_id = target_workspace;

  return query select true, new_reservation, 'Reserved.', effective_limit, used_count,
    greatest(0, effective_limit - used_count - 1), dispatch_time, next_time;
end;
$$;

revoke all on function public.reserve_sender_send(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.reserve_sender_send(uuid, uuid, jsonb) to service_role;

notify pgrst, 'reload schema';

-- Final visible confirmation. A successful run ends with one row saying READY.
select
  'READY'::text as scout_database_status,
  250::integer as hard_daily_ceiling,
  '90-210 seconds'::text as same_gmail_delay,
  '3-6 seconds'::text as different_gmail_delay,
  (select count(*) from information_schema.tables where table_schema = 'public')::integer as public_tables_found;
-- <<< END SCOUT_V10_37_FINAL_FIRST_INSTALL_PATCH

-- Secure the due-follow-up functions so an authenticated user can only query
-- their own workspace. Drop dependent functions first so this also upgrades an
-- older Scout database without the PostgreSQL 42P13 return-type error.
drop function if exists public.count_due_followups(uuid, text);
drop function if exists public.get_due_followups(uuid, integer, text);

create function public.get_due_followups(
  target_workspace uuid,
  limit_rows int default 100,
  followup_segment text default 'all_unanswered'
)
returns table (
  business_id uuid,
  business_name text,
  to_email text,
  website text,
  last_sent_at timestamptz,
  last_subject text,
  template_id uuid,
  gmail_account_id uuid,
  followup_segment text,
  reply_state text,
  last_auto_reply_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  with access_guard as (
    select 1 as allowed
    where auth.role() = 'service_role' or public.is_workspace_member(target_workspace)
  ), last_sent as (
    select distinct on (sm.business_id)
      sm.business_id,
      sm.sent_at,
      sm.subject,
      sm.template_id,
      sm.gmail_account_id
    from public.sent_messages sm
    cross join access_guard
    where sm.workspace_id = target_workspace
      and sm.status in ('sent', 'delivered', 'dry_run')
    order by sm.business_id, sm.sent_at desc nulls last
  ), reply_flags as (
    select
      rh.business_id,
      bool_or(coalesce(rh.is_real_reply, false)) as has_real_reply,
      bool_or(coalesce(rh.is_auto_reply, false)) as has_auto_reply,
      bool_or(coalesce(rh.is_delivery_failure, false) or coalesce(rh.is_blocked, false)) as has_bad_inbox,
      max(case when coalesce(rh.is_auto_reply, false) then rh.received_at else null end) as auto_reply_at
    from public.reply_history rh
    cross join access_guard
    where rh.workspace_id = target_workspace
    group by rh.business_id
  )
  select
    b.id as business_id,
    coalesce(b.name, '') as business_name,
    coalesce(b.email, '') as to_email,
    coalesce(b.website, '') as website,
    ls.sent_at as last_sent_at,
    ls.subject as last_subject,
    ls.template_id,
    ls.gmail_account_id,
    case when coalesce(rf.has_auto_reply, false) then 'auto_reply' else 'no_reply' end as followup_segment,
    case when coalesce(rf.has_auto_reply, false) then 'auto_reply' else 'no_reply' end as reply_state,
    rf.auto_reply_at as last_auto_reply_at
  from public.businesses b
  join last_sent ls on ls.business_id = b.id
  left join reply_flags rf on rf.business_id = b.id
  cross join access_guard
  where b.workspace_id = target_workspace
    and coalesce(b.email, '') <> ''
    and coalesce(b.status, '') not in ('responded', 'bad_inbox', 'bounced', 'no_inbox', 'blocked', 'invalid', 'duplicate', 'archived')
    and ls.sent_at <= now() - interval '72 hours'
    and coalesce(rf.has_real_reply, false) = false
    and coalesce(rf.has_bad_inbox, false) = false
    and (
      $3 in ('all', 'all_unanswered', '')
      or ($3 = 'no_reply' and coalesce(rf.has_auto_reply, false) = false)
      or ($3 = 'auto_reply' and coalesce(rf.has_auto_reply, false) = true)
    )
  order by ls.sent_at asc
  limit greatest(1, limit_rows);
$$;

revoke all on function public.get_due_followups(uuid, integer, text) from public, anon;
grant execute on function public.get_due_followups(uuid, integer, text) to authenticated, service_role;

create function public.count_due_followups(
  target_workspace uuid,
  followup_segment text default 'all_unanswered'
)
returns bigint
language sql
security definer
set search_path = public
as $$
  select case
    when auth.role() = 'service_role' or public.is_workspace_member(target_workspace)
    then (select count(*) from public.get_due_followups(target_workspace, 2147483647, followup_segment))
    else 0::bigint
  end;
$$;

revoke all on function public.count_due_followups(uuid, text) from public, anon;
grant execute on function public.count_due_followups(uuid, text) to authenticated, service_role;

notify pgrst, 'reload schema';

select
  'READY'::text as scout_database_status,
  250::integer as hard_daily_ceiling,
  '90-210 seconds'::text as same_gmail_delay,
  '3-6 seconds'::text as different_gmail_delay,
  to_regprocedure('public.count_due_followups(uuid,text)') is not null as all_followups_ready;

alter table if exists public.team_scouted_leads enable row level security;
notify pgrst, 'reload schema';

-- >>> SCOUT V10.38 FINAL SENDER RECOVERY + THREE-STRIKE PATCH
alter table if exists public.gmail_accounts add column if not exists safety_override_active boolean not null default false;
alter table if exists public.gmail_accounts add column if not exists pause_issue_key text;
alter table if exists public.gmail_accounts add column if not exists pause_issue_count integer not null default 0;
alter table if exists public.gmail_accounts add column if not exists pause_issue_window_started_at timestamptz;
alter table if exists public.gmail_accounts add column if not exists pause_issue_window_ends_at timestamptz;
alter table if exists public.gmail_accounts add column if not exists pause_issue_last_at timestamptz;
alter table if exists public.gmail_accounts add column if not exists hard_restriction_active boolean not null default false;
alter table if exists public.gmail_accounts add column if not exists hard_restricted_until timestamptz;
alter table if exists public.gmail_accounts add column if not exists hard_restriction_reason text;
alter table if exists public.gmail_accounts add column if not exists hard_restriction_count integer not null default 0;
alter table if exists public.gmail_accounts add column if not exists connection_status text not null default 'not_checked';
alter table if exists public.gmail_accounts add column if not exists connection_verified_at timestamptz;
alter table if exists public.gmail_accounts add column if not exists connection_error text;

create index if not exists gmail_accounts_hard_restriction_idx
  on public.gmail_accounts(workspace_id, hard_restriction_active, hard_restricted_until);

update public.gmail_accounts
set safety_override_active = false
where safety_override_active is null;

drop function if exists public.reserve_sender_send(uuid, uuid, jsonb);

create function public.reserve_sender_send(
  target_workspace uuid,
  target_account uuid,
  reservation_raw jsonb default '{}'::jsonb
)
returns table(
  allowed boolean,
  reservation_id uuid,
  reason text,
  effective_daily_limit integer,
  used_last_24h integer,
  remaining integer,
  dispatch_at timestamptz,
  next_eligible_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  a public.gmail_accounts%rowtype;
  deployment_limit integer;
  health_limit integer;
  user_limit integer;
  effective_limit integer;
  checkpoint_limit integer;
  used_count integer;
  new_reservation uuid;
  dispatch_time timestamptz;
  workspace_next timestamptz;
  next_time timestamptz;
  workspace_gap_seconds integer;
  override_active boolean;
  automatic_pause boolean;
  timed_pause_expired boolean;
  hard_active boolean;
begin
  select * into a
  from public.gmail_accounts
  where id = target_account and workspace_id = target_workspace
  for update;

  if not found then
    return query select false, null::uuid, 'Sender account was not found.', 0, 0, 0, null::timestamptz, null::timestamptz;
    return;
  end if;

  deployment_limit := 250;
  override_active := coalesce(a.safety_override_active, false)
    and coalesce(a.pause_kind, '') <> ''
    and coalesce(a.pause_kind, '') <> 'manual';
  hard_active := coalesce(a.hard_restriction_active, false)
    and (a.hard_restricted_until is null or a.hard_restricted_until > now());

  if coalesce(a.hard_restriction_active, false)
     and a.hard_restricted_until is not null
     and a.hard_restricted_until <= now() then
    update public.gmail_accounts
    set hard_restriction_active = false,
        hard_restricted_until = null,
        hard_restriction_reason = null,
        pause_issue_key = null,
        pause_issue_count = 0,
        pause_issue_window_started_at = null,
        pause_issue_window_ends_at = null,
        pause_kind = null,
        paused_until = null,
        paused_reason = null,
        safety_override_active = false,
        safety_override_until = null,
        safety_override_warning = null,
        is_paused = false,
        status = 'connected',
        health_stage = 'recovering',
        health_cap = least(deployment_limit, 25),
        health_reason = 'The hard restriction ended. Scout restarted this Gmail in Recovering stage at 25/day.',
        updated_at = now()
    where id = target_account and workspace_id = target_workspace
    returning * into a;
    hard_active := false;
    override_active := false;
  end if;

  if hard_active then
    return query select false, null::uuid,
      coalesce(a.hard_restriction_reason, a.paused_reason, 'This Gmail is hard-restricted.'),
      0, 0, 0, null::timestamptz, a.next_eligible_at;
    return;
  end if;

  automatic_pause := coalesce(a.pause_kind, '') <> '' and coalesce(a.pause_kind, '') <> 'manual';
  timed_pause_expired := automatic_pause
    and coalesce(a.pause_kind, '') <> 'permanent_bounce'
    and a.paused_until is not null
    and a.paused_until <= now();

  if timed_pause_expired and not override_active then
    update public.gmail_accounts
    set is_paused = false,
        status = 'connected',
        pause_kind = null,
        paused_until = null,
        paused_reason = null,
        safety_override_active = false,
        safety_override_until = null,
        safety_override_warning = null,
        health_stage = 'recovering',
        health_cap = least(deployment_limit, 50),
        health_reason = 'The timed safety pause ended. Scout restarted this Gmail in Recovering stage at 50/day.',
        updated_at = now()
    where id = target_account and workspace_id = target_workspace
    returning * into a;
    automatic_pause := false;
  elsif automatic_pause and not override_active then
    update public.gmail_accounts
    set is_paused = true,
        health_cap = 0,
        status = case when pause_kind = 'provider_limit' then 'limit_hit' else 'paused' end,
        safety_override_active = false,
        safety_override_until = null,
        updated_at = now()
    where id = target_account and workspace_id = target_workspace
    returning * into a;
  elsif override_active then
    update public.gmail_accounts
    set is_paused = false,
        status = 'connected',
        health_stage = 'recovering',
        health_cap = least(deployment_limit, 50),
        updated_at = now()
    where id = target_account and workspace_id = target_workspace
    returning * into a;
  end if;

  checkpoint_limit := case
    when coalesce(a.successful_sends, 0) < 25 then least(deployment_limit, 25)
    when coalesce(a.successful_sends, 0) < 50 then least(deployment_limit, 50)
    when coalesce(a.successful_sends, 0) < 100 then least(deployment_limit, 100)
    when coalesce(a.successful_sends, 0) < 150 then least(deployment_limit, 150)
    else deployment_limit
  end;

  health_limit := case lower(coalesce(a.health_stage, 'assessment'))
    when 'assessment' then checkpoint_limit
    when 'restricted' then least(deployment_limit, 50)
    when 'recovering' then least(deployment_limit, 75)
    when 'stable' then least(deployment_limit, 100)
    when 'established' then least(deployment_limit, 150)
    when 'healthy' then least(deployment_limit, 200)
    when 'proven' then deployment_limit
    when 'paused' then case when override_active then least(deployment_limit, 50) else 0 end
    else checkpoint_limit
  end;
  health_limit := least(health_limit, greatest(0, coalesce(a.health_cap, health_limit)));
  if override_active then health_limit := least(deployment_limit, 50); end if;
  user_limit := greatest(1, least(deployment_limit, coalesce(a.daily_limit, deployment_limit)));
  effective_limit := greatest(0, least(deployment_limit, health_limit, user_limit));

  select count(*)::integer into used_count
  from public.sender_send_reservations r
  where r.workspace_id = target_workspace
    and r.gmail_account_id = target_account
    and (
      (r.status = 'sent' and r.finalized_at >= now() - interval '24 hours')
      or (r.status = 'reserved' and r.expires_at > now())
    );

  if coalesce(a.pause_kind, '') = 'manual'
     or (coalesce(a.is_paused, false) and not override_active)
     or (lower(coalesce(a.status, '')) in ('paused', 'limit_hit', 'blocked', 'error') and not override_active)
     or (automatic_pause and not override_active) then
    return query select false, null::uuid,
      coalesce(a.paused_reason, a.health_reason, a.last_error, 'Sender is paused.'),
      effective_limit, used_count, greatest(0, effective_limit - used_count), null::timestamptz, a.next_eligible_at;
    return;
  end if;

  if a.next_eligible_at is not null and a.next_eligible_at > now() then
    return query select false, null::uuid, 'Sender cooldown is still active.',
      effective_limit, used_count, greatest(0, effective_limit - used_count), null::timestamptz, a.next_eligible_at;
    return;
  end if;

  if effective_limit <= 0 or used_count >= effective_limit then
    return query select false, null::uuid, 'Sender reached its effective rolling 24-hour limit.',
      effective_limit, used_count, greatest(0, effective_limit - used_count), null::timestamptz, a.next_eligible_at;
    return;
  end if;

  insert into public.workspace_dispatch_state(workspace_id, next_dispatch_at)
  values (target_workspace, now())
  on conflict (workspace_id) do nothing;

  select s.next_dispatch_at into workspace_next
  from public.workspace_dispatch_state s
  where s.workspace_id = target_workspace
  for update;

  dispatch_time := greatest(now(), coalesce(workspace_next, now()));
  if dispatch_time > now() + interval '45 seconds' then
    return query select false, null::uuid,
      'Workspace dispatch slots are full for this worker cycle. Scout will retry automatically.',
      effective_limit, used_count, greatest(0, effective_limit - used_count), dispatch_time, a.next_eligible_at;
    return;
  end if;

  workspace_gap_seconds := 3 + floor(random() * 4)::integer;
  update public.workspace_dispatch_state
  set next_dispatch_at = dispatch_time + make_interval(secs => workspace_gap_seconds), updated_at = now()
  where workspace_id = target_workspace;

  next_time := dispatch_time + make_interval(secs => (90 + floor(random() * 121))::integer);
  insert into public.sender_send_reservations(
    workspace_id, gmail_account_id, status, effective_daily_limit, used_before, dispatch_at, expires_at, raw
  ) values (
    target_workspace, target_account, 'reserved', effective_limit, used_count, dispatch_time,
    dispatch_time + interval '10 minutes', coalesce(reservation_raw, '{}'::jsonb)
  ) returning id into new_reservation;

  update public.gmail_accounts
  set next_eligible_at = next_time,
      health_cap = health_limit,
      updated_at = now()
  where id = target_account and workspace_id = target_workspace;

  return query select true, new_reservation, 'Reserved.', effective_limit, used_count,
    greatest(0, effective_limit - used_count - 1), dispatch_time, next_time;
end;
$$;

revoke all on function public.reserve_sender_send(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.reserve_sender_send(uuid, uuid, jsonb) to service_role;

notify pgrst, 'reload schema';

select
  'READY'::text as scout_database_status,
  250::integer as hard_daily_ceiling,
  '90-210 seconds'::text as same_gmail_delay,
  '3-6 seconds'::text as different_gmail_delay,
  '3 occurrences in 14 days'::text as hard_restriction_rule,
  to_regprocedure('public.reserve_sender_send(uuid,uuid,jsonb)') is not null as sender_safety_ready;
-- <<< END SCOUT V10.38 FINAL SENDER RECOVERY + THREE-STRIKE PATCH
