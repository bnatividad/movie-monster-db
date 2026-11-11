-- Applied to Supabase project cbzmmwtvjkktqokehnqg on 2026-11-11 (migration "weekly_summary")
-- Switch the summary from daily to weekly
select cron.unschedule('tracker-daily-summary');
-- Mondays at 00:13 UTC = Monday 8:13 AM Philippine time
select cron.schedule('tracker-weekly-summary', '13 0 * * 1', $$select public.call_tracker('summary')$$);
