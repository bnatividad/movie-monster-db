-- Applied to Supabase project cbzmmwtvjkktqokehnqg on 2026-11-11 (migration "summary_sunday_9am")
-- Move the weekly summary to Sundays at 01:00 UTC = Sunday 9:00 AM Philippine time
-- (cron.schedule with an existing job name updates that job)
select cron.schedule('tracker-weekly-summary', '0 1 * * 0', $$select public.call_tracker('summary')$$);
