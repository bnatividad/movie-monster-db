# Movie Monster DB — project brief

Handoff from the first planning/build session (2026-11-10 → 11). Read this first.

## The business idea
- A service that gives **customers in the Philippines** convenient access to TV series and movies (global titles).
- The owner handles **licensing and the actual sharing/access** separately. **This codebase only tracks releases**: knowing when a movie or episode is out, not hosting or distributing any media.
- Monetization: probably one-off payments (undecided, can change).
- Interfaces planned: **website** + **chatbot** (on the site and in a messaging app).

## Requirements decided so far
| Topic | Decision |
|---|---|
| "Released" means | Released **anywhere in the world** |
| Release types | Streaming platforms + digital (VOD) + Blu-ray/physical |
| TV | Track **new seasons and new episodes** |
| Platforms | All platforms |
| Content | All: Western, K-drama, anime, Filipino, etc. |
| "Popular" | Two lists: **global trending** and **trending in PH** |
| Tracked set | ~10–20 titles (currently = whatever is on the two charts, kept for 14 days after leaving) |
| User picks | Later: users can search and add their own titles |
| User accounts | Skipped for now |
| Alerts | **Owner only** for now; **weekly summary** (Sundays) |
| Alert channels | **Discord (live)**; Telegram supported in code but not set up yet |
| Check frequency | Hourly is fine |

## Architecture (live)
- **Supabase** = the engine: database + edge function + scheduler.
  - Project: `release-tracker`, ref **`cbzmmwtvjkktqokehnqg`**, region ap-southeast-1 (Singapore), org "bman".
  - Dashboard: https://supabase.com/dashboard/project/cbzmmwtvjkktqokehnqg
- **Website** (not built yet): will live on **Vercel** (public, own domain) or a Claude Artifact (private preview), reading Supabase with the publishable/anon key (read-only via RLS).

### Data sources
- **TMDB API**: global trending (`/trending/all/week`), PH-available popular (`/discover/*?watch_region=PH`), movie release dates (type 4 = digital, 5 = physical), TV episodes/seasons, PH watch providers (JustWatch data).
- **Netflix official Top 10, Philippines** (`https://www.netflix.com/tudum/top10/data/all-weeks-countries.tsv`, weekly). Titles are matched to TMDB by search.
- PH list = Netflix PH Top 10 interleaved with TMDB "popular & available in PH", deduped, top 10.

### Database tables (public schema)
- `titles`: one row per movie/show, with release dates, PH providers, last/next episode, `tracked` flag.
- `trending`: snapshots of the `global` and `ph` lists (rank, source, captured_at).
- `release_events`: one row per release event (`digital`, `physical`, `streaming:<provider>`, `Sxx`, `SxxEyy`). Unique `(title_id, event_key)`; `notified_at` null = not yet sent.
- `settings`: private key/value (`cron_secret`, `telegram_chat_id`). No public access.
- `run_log`: every job run with ok/error + info.
- RLS: anon can SELECT `titles`, `trending`, `release_events` only.

### Edge function `tracker` (verify_jwt = false; auth via `x-cron-secret` header = `settings.cron_secret`)
Actions (POST `{"action": ...}`):
- `refresh`: save both trending lists, mark tracked titles, check releases, insert new events. First check of a title records old releases silently (only the last 3 days get alerted).
- `summary`: post the weekly summary (recently released (last 7 days), coming this week, both charts, with where-to-watch details from live TMDB lookups) to Discord and/or Telegram, then mark events notified.
- `preview`: build the same message as `summary` and return it as `markdown`. Sends nothing and marks nothing notified. Run `select public.call_tracker('preview');` and read the result from `net._http_response` by the returned id.
- `preview_send`: same as `preview`, but also posts it with a "layout preview" note at the top. Goes only to `DISCORD_TEST_WEBHOOK_URL` when that secret is set, otherwise to the normal alert channels. Still marks nothing notified.
- `test`: send a test message to all configured channels.

Source: `supabase/functions/tracker/index.ts`

### Schedule (pg_cron + pg_net, via `public.call_tracker(action)`)
- `tracker-refresh`: `7 * * * *` (hourly)
- `tracker-weekly-summary`: `0 1 * * 0` (Sundays 9:00 AM PH time; was daily at 8:13 AM until 2026-11-11)
- Manual run from SQL: `select public.call_tracker('refresh');`, then check `select * from run_log order by ran_at desc limit 5;`

### Secrets (Supabase → Edge Functions → Secrets; never commit values)
- `TMDB_TOKEN`: TMDB API Read Access Token (set)
- `DISCORD_WEBHOOK_URL`: Discord channel webhook for the real summary (set)
- `DISCORD_TEST_WEBHOOK_URL`: optional Discord webhook for a test channel. Used only by `preview_send`
- `TELEGRAM_BOT_TOKEN`: optional, not set yet (then send `/start` to the bot)

## Status (as of 2026-11-11)
- ✅ Refresh runs hourly with no failures since keys were added (~20–31 titles tracked).
- ✅ Discord test message and daily summaries delivered. Switched to weekly on 2026-11-11; where-to-watch details added (function v13); "Recently released" section and date-grouped "Coming this week" added 2026-11-12 (v16).
- Migrations in `supabase/migrations/` match what was applied. Message layout is specified in `TEMPLATE.md` (example in `TEMPLATE_SAMPLE.md`).

## Known issues / ideas
- Tracked set grows to ~30 because the 14-day window accumulates chart churn. The target was 10–20, so consider shortening the window or capping it.
- Daily talk shows (e.g. *Jimmy Kimmel Live!*) flood episode events. Consider filtering talk/news/daily shows.
- A refresh takes ~60s, mostly from downloading the large Netflix TSV. Fine (the timeout is 150s), but it could be cached or fetched weekly.
- Netflix→TMDB matching uses the first search hit, so it can mismatch similar titles.
- Blu-ray coverage depends on TMDB (type 5). blu-ray.com has more data but no API.

## Next steps
1. **Website v1**: two lists (Global trending, Trending in PH) + tracked titles with release status. Host on Vercel.
2. Let the owner add or search their own titles to track (user picks).
3. Chatbot: Discord/Telegram bot and/or site chat ("is X out yet?") reading the same tables.
4. Later: customer accounts, watchlists, customer alerts (Messenger/Viber are popular in PH).
