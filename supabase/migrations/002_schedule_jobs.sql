-- Applied to Supabase project cbzmmwtvjkktqokehnqg on 2026-11-10 (migration "schedule_jobs")
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Random shared secret the edge function checks (x-cron-secret header). Never commit its value.
insert into public.settings (key, value)
values ('cron_secret', encode(gen_random_bytes(24), 'hex'))
on conflict (key) do nothing;

-- Helper: call the tracker edge function with an action
create or replace function public.call_tracker(p_action text)
returns bigint
language sql
security definer
set search_path = public, extensions
as $$
  select net.http_post(
    url := 'https://cbzmmwtvjkktqokehnqg.supabase.co/functions/v1/tracker',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select value from public.settings where key = 'cron_secret')
    ),
    body := jsonb_build_object('action', p_action),
    timeout_milliseconds := 150000
  );
$$;
revoke all on function public.call_tracker(text) from public, anon, authenticated;

-- Hourly refresh at :07
select cron.schedule('tracker-refresh', '7 * * * *', $$select public.call_tracker('refresh')$$);
-- Daily summary at 00:13 UTC = 8:13 AM Philippine time
select cron.schedule('tracker-daily-summary', '13 0 * * *', $$select public.call_tracker('summary')$$);
