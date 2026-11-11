# Discord notification template

The layout of the messages the `tracker` edge function posts to Discord. It matches what [`summary()` and `testAlerts()` in index.ts](supabase/functions/tracker/index.ts) send today. Edit this file to design changes, then update the code and [TEMPLATE_SAMPLE.md](TEMPLATE_SAMPLE.md) (example output) to match.

`{placeholders}` are filled in by the function. Everything else is literal text. Discord renders `**bold**`, `_italic_`, `- ` bullet lists (with `  - ` sub-items) and `1.` numbered lists. Movie and show titles are always **bold**.

The `preview` action builds this same message without sending it, and `preview_send` posts it with a "layout preview" note. Neither marks releases as sent.

## Weekly summary

Sent by the `summary` action, every Sunday at 9:00 AM PH time. Covers everything since the previous summary.

```
**🎬 Weekly Release Summary — {date}**

**New releases ({event_count})**
- **{title} ({TV|Movie})**
  - {event_detail} · {event_date}
  - {event_detail} · {event_date}
  - …and {more_count} more

**Coming this week**
- {date} · **{title}** _S{season}E{episode}_ · {where}
- {date} · **{title}** _({release_types})_ · {where}

**🌍 Trending Globally**
{rank}. **{title}** _({year})_{ (TV)} · {where}

**🇵🇭 Trending in PH**
{rank}. **{title}** _({year})_{ (TV)} · {where}
```

`{release_types}` lists every release for that title on that date in one entry: `digital`, `Blu-ray`, `PH cinemas`, e.g. `(digital, Blu-ray)`.

### Where to watch (`{where}`)

Shown at the end of the entry's line in normal text. Parts are joined with ` · `. When no part applies, the line ends after the title (no trailing ` · `).

| Part | Shown when | Example |
|---|---|---|
| `Stream: {platforms}` | Available in PH by subscription, free or with ads | `Stream: Netflix, Amazon Prime Video` |
| `Rent/Buy: {platforms}` | Available in PH to rent or buy (platforms already listed under Stream are left out) | `Rent/Buy: Apple TV Store` |
| `Airs on {network} · not on PH platforms` | Shows with no PH platform: the network it airs on | `Airs on Disney+ · not on PH platforms` |
| `PH cinemas from {date}` | Movies with no PH streaming and an upcoming PH cinema date | `PH cinemas from 16 Dec 2026` |
| `In PH cinemas since {date}` | Movies with no PH streaming that opened in PH cinemas in the last 30 days (older cinema dates are left out) | `In PH cinemas since 04 Nov 2026` |

PH platforms come from TMDB (JustWatch data). They show where a title is available now, not where an upcoming release will land.

### Sections

| Section | Shown when | Notes |
|---|---|---|
| Header | Always | `{date}` is today in UTC |
| New releases | There are events not yet notified | If there are none, this line shows instead: `No new releases since the last summary.` Grouped by title, newest event first, at most 6 lines per title, then `…and N more` |
| Coming this week | Something is due within 7 days | Sorted by date. Covers the next episode of each tracked show and upcoming digital, Blu-ray or PH cinema dates for movies, one entry per title per date. The year is left out of `{date}` (`10 Nov`) when every entry is in the same year |
| Trending Globally / Trending in PH | The list has a snapshot | Latest snapshot, top 10. `{year}` is the year of release (movies) or first air date (shows), in italics. ` (TV)` is added for shows only |

### Event detail lines (`{event_detail}`)

| Event | Text | Date shown |
|---|---|---|
| Digital | `Digital release (first in {country})` | Yes |
| Physical | `Blu-ray/DVD release (first in {country})` | Yes |
| Streaming | `Available in PH on {provider}` | No |
| Season | `Season {n} premiered` | Yes |
| Episode | `S{ss}E{ee} "{episode name}"` | Yes |

All dates (`{date}`, `{event_date}`) use the format `DD MMM YYYY`, for example `11 Nov 2026`.

`{country}` is a two-letter code such as `US`. Season and episode numbers are zero-padded (`S02E05`).

## Test message

Sent by the `test` action.

```
✅ **Release tracker connected.** You'll get a weekly summary here.
```

## Delivery rules

- Posted through the webhook as **Release Tracker**, with link previews (embeds) turned off and @mentions blocked.
- Messages over about 1,900 characters are split at line breaks into several posts, because Discord's limit is 2,000.
- The characters `` * _ ~ ` | `` are removed from titles and detail lines so they can't break the formatting.
- Telegram gets the same content, converted to HTML and cut off at about 4,000 characters. Telegram has no lists, so `- ` becomes `•` and `  - ` becomes `–`.
