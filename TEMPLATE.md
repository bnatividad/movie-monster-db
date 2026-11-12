# Discord notification template

The layout of the messages the `tracker` edge function posts to Discord. It matches what [`summary()` and `testAlerts()` in index.ts](supabase/functions/tracker/index.ts) send today. Edit this file to design changes, then update the code and [TEMPLATE_SAMPLE.md](TEMPLATE_SAMPLE.md) (example output) to match.

`{placeholders}` are filled in by the function. Everything else is literal text. Discord renders `**bold**`, `_italic_`, `- ` bullet lists (with `  - ` sub-items), `1.` numbered lists and `-# ` subtext (a small grey line, used as a subtitle). Movie and show titles are always **bold**.

The `preview` action builds this same message without sending it, and `preview_send` posts it with a "layout preview" note (to the test channel when `DISCORD_TEST_WEBHOOK_URL` is set). Neither marks releases as sent.

## Weekly summary

Sent by the `summary` action, every Sunday at 9:00 AM PH time.

```
**🎬 Weekly Release Summary — {date}**

**Recently released**
- **{title}** _S{season}E{episode}–E{episode}_
-# {where}
- **{title}** _({release_types})_
-# {where}

**Coming this week**
**{weekday} {date}**
- **{title}** _S{season}E{episode}_
-# {where}
- **{title}** _({release_types})_
-# {where}
**{weekday} {date}**
- **{title}** _S{season}E{episode}_
-# {where}

**🌍 Trending Globally**
{rank}. **{title}** _({year})_{ (TV)}
-# {where}

**🇵🇭 Trending in PH**
{rank}. **{title}** _({year})_{ (TV)}
-# {where}
```

- **Recently released** has no dates: one entry per title for the whole week, with consecutive episodes collapsed into a range (`S25E32–E35`).
- **Coming this week** is grouped under a bold date line (`**Fri 13 Nov**`), one entry per title per date.
- In both, episodes come first and consecutive episodes are collapsed into a range, for example `S03E01–E04`.
- `{release_types}` lists the title's other releases on that date: `digital`, `Blu-ray`, `PH cinemas`, `Season {n}`, or `new on {platform}` (Recently released only), e.g. `(digital, Blu-ray)`. `Season {n}` is left out when that day's episodes are listed.

### Where to watch (`{where}`)

Shown as a subtitle line (`-# `) under the entry. Parts are joined with ` · `. The subtitle line is left out when no part applies.

| Part | Shown when | Example |
|---|---|---|
| `{platforms}` | Available in PH by subscription, free or with ads. No label: streaming is the default | `Netflix, Amazon Prime Video` |
| `{platforms} (rent/buy)` | Available in PH to rent or buy (platforms already listed as streaming are left out) | `Apple TV Store (rent/buy)` |
| `Airs on {network} · not on PH platforms` | Shows with no PH platform: the network it airs on | `Airs on Disney+ · not on PH platforms` |
| `PH cinemas from {date}` | Movies with no PH streaming and an upcoming PH cinema date | `PH cinemas from 16 Dec 2026` |
| `In PH cinemas since {date}` | Movies with no PH streaming that opened in PH cinemas in the last 30 days (older cinema dates are left out) | `In PH cinemas since 04 Nov 2026` |

PH platforms come from TMDB (JustWatch data). They show where a title is available now, not where an upcoming release will land.

### Sections

| Section | Shown when | Notes |
|---|---|---|
| Header | Always | `{date}` is today in UTC |
| Recently released | Something came out in the last 7 days (today included) | Sorted by each title's latest release, newest first. Covers episodes, season premieres, digital and Blu-ray releases, and titles newly added to a PH platform. Platforms a title was already on when it was first tracked are not counted as new |
| Coming this week | Something is due in the next 7 days (after today) | Grouped under date lines, in date order, titles A–Z within a date. Covers the next episode of each tracked show and upcoming digital, Blu-ray or PH cinema dates for movies |
| (fallback) | Both sections above are empty | `No releases in the last 7 days or the next 7.` |
| Trending Globally / Trending in PH | The list has a snapshot | Latest snapshot, top 10. `{year}` is the year of release (movies) or first air date (shows), in italics. ` (TV)` is added for shows only |

All dates use the format `DD MMM YYYY`, for example `11 Nov 2026`.

In the Coming this week date lines, the year is left out of `{date}` (`Fri 13 Nov`) when every entry is in the same year. Season and episode numbers are zero-padded (`S02E05`).

## Test message

Sent by the `test` action.

```
✅ **Release tracker connected.** You'll get a weekly summary here.
```

## Delivery rules

- Posted through the webhook as **Release Tracker**, with link previews (embeds) turned off and @mentions blocked.
- Messages over about 1,900 characters are split at line breaks into several posts, because Discord's limit is 2,000.
- The characters `` * _ ~ ` | `` are removed from titles and detail lines so they can't break the formatting.
- Telegram gets the same content, converted to HTML and cut off at about 4,000 characters. Telegram has no lists or subtext, so `- ` becomes `•`, `  - ` becomes `–`, and `-# ` lines become indented italic lines.
