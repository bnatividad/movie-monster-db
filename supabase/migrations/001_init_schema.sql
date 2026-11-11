-- Applied to Supabase project cbzmmwtvjkktqokehnqg on 2026-11-10 (migration "init_schema")
create table public.titles (
  id bigint generated always as identity primary key,
  tmdb_id integer not null,
  media_type text not null check (media_type in ('movie','tv')),
  title text not null,
  original_language text,
  overview text,
  poster_path text,
  first_air_or_release date,
  popularity numeric,
  tracked boolean not null default true,
  status text,                       -- e.g. 'Released', 'Returning Series', 'Ended'
  digital_release date,              -- earliest worldwide digital release (movies)
  physical_release date,             -- earliest worldwide physical/Blu-ray release (movies)
  ph_providers text[] default '{}',  -- streaming platforms in PH
  latest_season integer,
  last_episode jsonb,                -- {season, episode, name, air_date}
  next_episode jsonb,
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tmdb_id, media_type)
);

create table public.trending (
  id bigint generated always as identity primary key,
  list text not null check (list in ('global','ph')),
  source text not null,
  rank integer not null,
  title_id bigint not null references public.titles(id) on delete cascade,
  captured_at timestamptz not null default now()
);
create index trending_latest_idx on public.trending (list, captured_at desc);

-- One row per release event; unique key prevents duplicates so each event alerts only once
create table public.release_events (
  id bigint generated always as identity primary key,
  title_id bigint not null references public.titles(id) on delete cascade,
  kind text not null check (kind in ('digital','physical','streaming','season','episode')),
  event_key text not null,          -- e.g. 'digital', 'S02', 'S02E05', 'streaming:Netflix'
  event_date date,
  detail text,
  detected_at timestamptz not null default now(),
  notified_at timestamptz,
  unique (title_id, event_key)
);

create table public.settings (
  key text primary key,
  value text
);

create table public.run_log (
  id bigint generated always as identity primary key,
  job text not null,
  ok boolean not null,
  info jsonb,
  ran_at timestamptz not null default now()
);

-- Read-only public access for the website; writes only via service role (edge functions)
alter table public.titles enable row level security;
alter table public.trending enable row level security;
alter table public.release_events enable row level security;
alter table public.settings enable row level security;
alter table public.run_log enable row level security;

create policy "public read titles" on public.titles for select to anon, authenticated using (true);
create policy "public read trending" on public.trending for select to anon, authenticated using (true);
create policy "public read events" on public.release_events for select to anon, authenticated using (true);
-- settings and run_log: no public policies (private)
