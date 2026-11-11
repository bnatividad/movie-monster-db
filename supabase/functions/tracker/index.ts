// Release tracker edge function.
// Actions (POST body {"action": ...} or ?action=...):
//   refresh  - pull trending lists (global + PH), check releases for tracked titles
//   summary  - send the weekly summary of new releases to Discord and/or Telegram
//   preview  - build the summary and return it; sends nothing, marks nothing sent
//   preview_send - same, but also posts it (labelled as a preview) to DISCORD_TEST_WEBHOOK_URL if set,
//                  otherwise to the normal alert channels; marks nothing sent
//   test     - send a test message to every configured channel (Telegram: send /start to the bot first)
// Every call must carry header  x-cron-secret: <settings.cron_secret>
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const TMDB = "https://api.themoviedb.org/3";
const NETFLIX_TSV = "https://www.netflix.com/tudum/top10/data/all-weeks-countries.tsv";
const LIST_SIZE = 10;
const TRACK_DAYS = 14; // keep tracking a title this many days after it leaves the charts
const today = () => new Date().toISOString().slice(0, 10);
// "2026-11-11" -> "11 Nov 2026" (display only; keep ISO for comparisons/sorting)
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDate = (iso: string, withYear = true) => {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d} ${MONTHS[Number(m) - 1]}${withYear ? ` ${y}` : ""}`;
};

// ---------- TMDB ----------
async function tmdb(path: string, params: Record<string, string> = {}) {
  const token = Deno.env.get("TMDB_TOKEN");
  if (!token) throw new Error("TMDB_TOKEN secret is not set");
  const url = new URL(TMDB + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers: Record<string, string> = { accept: "application/json" };
  // Long JWT-style "Read Access Token" -> Bearer; short v3 key -> query param
  if (token.length > 40) headers.authorization = `Bearer ${token}`;
  else url.searchParams.set("api_key", token);
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); continue; }
    if (!res.ok) throw new Error(`TMDB ${path} -> ${res.status}`);
    return await res.json();
  }
  throw new Error(`TMDB ${path} rate limited`);
}

type Item = { tmdb_id: number; media_type: "movie" | "tv"; source: string };

async function upsertTitle(tmdbId: number, mediaType: "movie" | "tv", summary?: any) {
  const s = summary ?? await tmdb(`/${mediaType}/${tmdbId}`);
  const row = {
    tmdb_id: tmdbId,
    media_type: mediaType,
    title: s.title ?? s.name ?? "Untitled",
    original_language: s.original_language,
    overview: s.overview,
    poster_path: s.poster_path,
    first_air_or_release: (s.release_date || s.first_air_date) || null,
    popularity: s.popularity,
  };
  const { data, error } = await db.from("titles")
    .upsert(row, { onConflict: "tmdb_id,media_type" }).select("id").single();
  if (error) throw error;
  return data.id as number;
}

// ---------- Trending lists ----------
async function globalTrending(): Promise<Item[]> {
  const j = await tmdb("/trending/all/week");
  return j.results
    .filter((r: any) => r.media_type === "movie" || r.media_type === "tv")
    .slice(0, LIST_SIZE)
    .map((r: any) => ({ tmdb_id: r.id, media_type: r.media_type, source: "tmdb_global", _s: r }));
}

// Netflix's official weekly Top 10 for the Philippines (films + TV)
async function netflixPH(): Promise<Item[]> {
  const res = await fetch(NETFLIX_TSV);
  if (!res.ok || !res.body) throw new Error(`Netflix top10 -> ${res.status}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "", header: string[] | null = null;
  const rows: Record<string, string>[] = [];
  let latest = "";
  const handle = (line: string) => {
    if (!line) return;
    const cols = line.split("\t");
    if (!header) { header = cols; return; }
    if (!line.includes("Philippines")) return;
    const r: Record<string, string> = {};
    header.forEach((h, i) => (r[h] = cols[i]));
    if (r.country_iso2 !== "PH") return;
    if (r.week > latest) { latest = r.week; rows.length = 0; }
    if (r.week === latest) rows.push(r);
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { handle(buf.slice(0, i).replace(/\r$/, "")); buf = buf.slice(i + 1); }
  }
  handle(buf);
  rows.sort((a, b) => Number(a.weekly_rank) - Number(b.weekly_rank) || (a.category < b.category ? -1 : 1));
  const out: Item[] = [];
  for (const r of rows) {
    const type = r.category.toLowerCase().startsWith("film") ? "movie" : "tv";
    const s = await tmdb(`/search/${type}`, { query: r.show_title });
    const hit = s.results?.[0];
    if (hit) out.push({ tmdb_id: hit.id, media_type: type, source: `netflix_ph (${r.week})`, _s: hit } as any);
  }
  return out;
}

// Most popular titles that are actually available on PH streaming/rent/buy platforms
async function tmdbPopularPH(): Promise<Item[]> {
  const params = { watch_region: "PH", with_watch_monetization_types: "flatrate|rent|buy|ads|free", sort_by: "popularity.desc" };
  const [m, t] = await Promise.all([tmdb("/discover/movie", params), tmdb("/discover/tv", params)]);
  const out: Item[] = [];
  for (let i = 0; i < 10; i++) {
    if (t.results[i]) out.push({ tmdb_id: t.results[i].id, media_type: "tv", source: "tmdb_ph_available", _s: t.results[i] } as any);
    if (m.results[i]) out.push({ tmdb_id: m.results[i].id, media_type: "movie", source: "tmdb_ph_available", _s: m.results[i] } as any);
  }
  return out;
}

async function phTrending(log: any): Promise<Item[]> {
  let nf: Item[] = [];
  try { nf = await netflixPH(); } catch (e) { log.netflix_error = String(e); }
  const tm = await tmdbPopularPH();
  // Interleave Netflix PH chart with PH-available popular titles, dedupe
  const seen = new Set<string>(), out: Item[] = [];
  for (let i = 0; out.length < LIST_SIZE && (i < nf.length || i < tm.length); i++) {
    for (const it of [nf[i], tm[i]]) {
      if (!it || out.length >= LIST_SIZE) continue;
      const k = `${it.media_type}:${it.tmdb_id}`;
      if (!seen.has(k)) { seen.add(k); out.push(it); }
    }
  }
  return out;
}

async function saveList(list: "global" | "ph", items: Item[]) {
  const capturedAt = new Date().toISOString();
  const rows = [];
  for (const [i, it] of items.entries()) {
    const id = await upsertTitle(it.tmdb_id, it.media_type, (it as any)._s);
    rows.push({ list, source: it.source, rank: i + 1, title_id: id, captured_at: capturedAt });
  }
  if (rows.length) {
    const { error } = await db.from("trending").insert(rows);
    if (error) throw error;
  }
}

// ---------- Release checks ----------
const providerNames = (wp: any) => {
  const ph = wp?.results?.PH;
  if (!ph) return [] as string[];
  const names = new Set<string>();
  for (const k of ["flatrate", "free", "ads", "rent", "buy"]) for (const p of ph[k] ?? []) names.add(p.provider_name);
  return [...names];
};

type Ev = { kind: string; event_key: string; event_date: string | null; detail: string };

async function checkMovie(t: any): Promise<{ patch: any; events: Ev[] }> {
  const m = await tmdb(`/movie/${t.tmdb_id}`, { append_to_response: "release_dates,watch/providers" });
  let digital: string | null = null, physical: string | null = null;
  let digitalCountry = "", physicalCountry = "";
  for (const c of m.release_dates?.results ?? []) {
    for (const d of c.release_dates ?? []) {
      const date = (d.release_date ?? "").slice(0, 10);
      if (!date) continue;
      if (d.type === 4 && (!digital || date < digital)) { digital = date; digitalCountry = c.iso_3166_1; }
      if (d.type === 5 && (!physical || date < physical)) { physical = date; physicalCountry = c.iso_3166_1; }
    }
  }
  const providers = providerNames(m["watch/providers"]);
  const events: Ev[] = [];
  const now = today();
  if (digital && digital <= now) events.push({ kind: "digital", event_key: "digital", event_date: digital, detail: `Digital release (first in ${digitalCountry})` });
  if (physical && physical <= now) events.push({ kind: "physical", event_key: "physical", event_date: physical, detail: `Blu-ray/DVD release (first in ${physicalCountry})` });
  for (const p of providers) events.push({ kind: "streaming", event_key: `streaming:${p}`, event_date: now, detail: `Available in PH on ${p}` });
  return {
    patch: { status: m.status, digital_release: digital, physical_release: physical, ph_providers: providers, popularity: m.popularity },
    events,
  };
}

async function checkTv(t: any): Promise<{ patch: any; events: Ev[] }> {
  const s = await tmdb(`/tv/${t.tmdb_id}`, { append_to_response: "watch/providers" });
  const providers = providerNames(s["watch/providers"]);
  const events: Ev[] = [];
  const now = today();
  const last = s.last_episode_to_air;
  const latestSeason = last?.season_number ?? null;
  if (latestSeason) {
    // Fetch the whole latest season so binge drops (many episodes at once) are all caught
    const season = await tmdb(`/tv/${t.tmdb_id}/season/${latestSeason}`);
    const aired = (season.episodes ?? []).filter((e: any) => e.air_date && e.air_date <= now);
    if (aired.length) {
      const first = aired[0];
      events.push({ kind: "season", event_key: `S${pad(latestSeason)}`, event_date: first.air_date, detail: `Season ${latestSeason} premiered` });
    }
    for (const e of aired) {
      events.push({
        kind: "episode", event_key: `S${pad(e.season_number)}E${pad(e.episode_number)}`, event_date: e.air_date,
        detail: `S${pad(e.season_number)}E${pad(e.episode_number)}${e.name ? ` "${e.name}"` : ""}`,
      });
    }
  }
  for (const p of providers) events.push({ kind: "streaming", event_key: `streaming:${p}`, event_date: now, detail: `Available in PH on ${p}` });
  const ep = (e: any) => e ? { season: e.season_number, episode: e.episode_number, name: e.name, air_date: e.air_date } : null;
  return {
    patch: { status: s.status, ph_providers: providers, latest_season: latestSeason, last_episode: ep(last), next_episode: ep(s.next_episode_to_air), popularity: s.popularity },
    events,
  };
}
const pad = (n: number) => String(n).padStart(2, "0");

async function checkReleases(log: any) {
  // Track anything that was on either chart in the last TRACK_DAYS days
  const since = new Date(Date.now() - TRACK_DAYS * 864e5).toISOString();
  const { data: recent } = await db.from("trending").select("title_id").gte("captured_at", since);
  const ids = [...new Set((recent ?? []).map((r) => r.title_id))];
  await db.from("titles").update({ tracked: false }).not("id", "in", `(${ids.join(",") || 0})`);
  await db.from("titles").update({ tracked: true }).in("id", ids.length ? ids : [0]);

  const { data: titles } = await db.from("titles").select("*").eq("tracked", true);
  let newEvents = 0;
  const errors: string[] = [];
  for (const t of titles ?? []) {
    try {
      const { patch, events } = t.media_type === "movie" ? await checkMovie(t) : await checkTv(t);
      const firstCheck = !t.checked_at;
      // On a title's first check, old releases are a silent baseline (no alert),
      // except things that came out in the last 3 days.
      const recentCutoff = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
      const rows = events.map((e) => ({
        title_id: t.id, ...e,
        notified_at: firstCheck && !(e.event_date && e.event_date >= recentCutoff && e.kind !== "streaming") ? new Date().toISOString() : null,
      }));
      if (rows.length) {
        const { data, error } = await db.from("release_events")
          .upsert(rows, { onConflict: "title_id,event_key", ignoreDuplicates: true }).select("id");
        if (error) throw error;
        newEvents += data?.length ?? 0;
      }
      await db.from("titles").update({ ...patch, checked_at: new Date().toISOString() }).eq("id", t.id);
    } catch (e) {
      errors.push(`${t.title}: ${e}`);
    }
  }
  log.tracked = titles?.length ?? 0;
  log.new_events = newEvents;
  if (errors.length) log.errors = errors;
}

async function refresh() {
  const log: any = {};
  await saveList("global", await globalTrending());
  await saveList("ph", await phTrending(log));
  await checkReleases(log);
  return log;
}

// ---------- Telegram ----------
async function tg(method: string, body: any) {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN secret is not set");
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description}`);
  return j.result;
}

async function getSetting(key: string) {
  const { data } = await db.from("settings").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}

async function chatId(): Promise<string> {
  const saved = await getSetting("telegram_chat_id");
  if (saved) return saved;
  const updates = await tg("getUpdates", {});
  const msg = [...updates].reverse().find((u: any) => u.message?.chat?.id);
  if (!msg) throw new Error("No chat found - open your bot in Telegram and send /start, then try again");
  const id = String(msg.message.chat.id);
  await db.from("settings").upsert({ key: "telegram_chat_id", value: id });
  return id;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function latestList(list: string) {
  const { data: last } = await db.from("trending").select("captured_at").eq("list", list)
    .order("captured_at", { ascending: false }).limit(1).maybeSingle();
  if (!last) return [];
  const { data } = await db.from("trending").select("rank, source, titles(tmdb_id, title, media_type, first_air_or_release)")
    .eq("list", list).eq("captured_at", last.captured_at).order("rank");
  return data ?? [];
}

// ---------- Discord ----------
async function discordSend(markdown: string, url: string) {
  // Discord messages max out at 2000 chars: split on line boundaries
  const chunks: string[] = [];
  let cur = "";
  for (const line of markdown.split("\n")) {
    if ((cur + "\n" + line).length > 1900) { chunks.push(cur); cur = line; }
    else cur = cur ? cur + "\n" + line : line;
  }
  if (cur) chunks.push(cur);
  for (const content of chunks) {
    const res = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, username: "Release Tracker", allowed_mentions: { parse: [] }, flags: 4 /* no embeds */ }),
    });
    if (!res.ok) throw new Error(`Discord webhook -> ${res.status} ${await res.text()}`);
  }
}

// Send to every configured channel; succeed if at least one worked.
// testing=true sends only to DISCORD_TEST_WEBHOOK_URL when that secret is set (else falls back to the normal channels).
async function broadcast(html: string, markdown: string, testing = false) {
  const testUrl = Deno.env.get("DISCORD_TEST_WEBHOOK_URL");
  if (testing && testUrl) {
    await discordSend(markdown, testUrl);
    return { sent: ["discord_test"], errors: [] as string[] };
  }
  const sent: string[] = [], errors: string[] = [];
  if (Deno.env.get("TELEGRAM_BOT_TOKEN")) {
    try {
      const id = await chatId();
      const text = html.length > 4000 ? html.slice(0, 3990) + "\n…" : html;
      await tg("sendMessage", { chat_id: id, text, parse_mode: "HTML", disable_web_page_preview: true });
      sent.push("telegram");
    } catch (e) { errors.push(String(e)); }
  }
  const discordUrl = Deno.env.get("DISCORD_WEBHOOK_URL");
  if (discordUrl) {
    try { await discordSend(markdown, discordUrl); sent.push("discord"); } catch (e) { errors.push(String(e)); }
  }
  if (!sent.length) throw new Error(errors.length ? errors.join("; ") : "No alert channel set: add DISCORD_WEBHOOK_URL and/or TELEGRAM_BOT_TOKEN");
  return { sent, errors };
}

// Lines use a tiny markup: **bold**, _italic_, "- " list items, "  - " sub-items and "-# " subtext lines.
// Kept as Markdown for Discord; rendered to HTML for Telegram (no lists or subtext there, so bullets
// become • and –, and subtext becomes an indented italic line).
// Safe because clean() strips * and _ from all dynamic text.
const toHtml = (lines: string[]) => lines.map((l) => esc(l)
  .replace(/^-# (.*)$/, "    <i>$1</i>")
  .replace(/^  - /, "   – ")
  .replace(/^- /, "• ")
  .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
  .replace(/_(.+?)_/g, "<i>$1</i>")).join("\n");

// ---------- Where to watch ----------
type Where = { stream: string[]; rentBuy: string[]; networks: string[]; phCinema: string | null };

// Live TMDB lookup: PH platforms split into stream vs rent/buy, original TV network, earliest PH cinema date
async function whereToWatch(tmdbId: number, mediaType: string): Promise<Where> {
  const m = await tmdb(`/${mediaType}/${tmdbId}`, { append_to_response: mediaType === "movie" ? "release_dates,watch/providers" : "watch/providers" });
  const ph = m["watch/providers"]?.results?.PH ?? {};
  const names = (keys: string[]) => [...new Set(keys.flatMap((k) => (ph[k] ?? []).map((p: any) => p.provider_name as string)))];
  const stream = names(["flatrate", "free", "ads"]);
  const rentBuy = names(["rent", "buy"]).filter((n) => !stream.includes(n));
  let phCinema: string | null = null;
  for (const c of m.release_dates?.results ?? []) {
    if (c.iso_3166_1 !== "PH") continue;
    for (const d of c.release_dates ?? []) {
      const date = (d.release_date ?? "").slice(0, 10);
      if ((d.type === 2 || d.type === 3) && date && (!phCinema || date < phCinema)) phCinema = date; // 2 = limited, 3 = theatrical
    }
  }
  return { stream, rentBuy, networks: (m.networks ?? []).map((n: any) => n.name as string), phCinema };
}

const whereText = (w: Where) => {
  const parts: string[] = [];
  // Streaming (subscription/free/ads) is the default and needs no label; only rent/buy is tagged
  if (w.stream.length) parts.push(w.stream.join(", "));
  if (w.rentBuy.length) parts.push(`${w.rentBuy.join(", ")} (rent/buy)`);
  if (!parts.length && w.networks.length) parts.push(`Airs on ${w.networks.join(", ")} · not on PH platforms`);
  // Cinema date only while it's relevant: upcoming, or opened in the last 30 days
  if (!w.stream.length && w.phCinema) {
    const monthAgo = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    if (w.phCinema > today()) parts.push(`PH cinemas from ${fmtDate(w.phCinema)}`);
    else if (w.phCinema >= monthAgo) parts.push(`In PH cinemas since ${fmtDate(w.phCinema)}`);
  }
  return parts.join(" · ");
};

async function buildSummary() {
  const { data: events } = await db.from("release_events")
    .select("id, kind, event_key, event_date, detail, titles(title, media_type)")
    .is("notified_at", null).order("event_date", { ascending: false });

  const lines: string[] = [`**🎬 Weekly Release Summary — ${fmtDate(today())}**`, ""];
  const evs = events ?? [];
  if (evs.length) {
    lines.push(`**New releases (${evs.length})**`);
    const byTitle = new Map<string, string[]>();
    for (const e of evs as any[]) {
      const k = `${e.titles.title} (${e.titles.media_type === "tv" ? "TV" : "Movie"})`;
      if (!byTitle.has(k)) byTitle.set(k, []);
      byTitle.get(k)!.push(`${e.detail}${e.event_date && e.kind !== "streaming" ? ` · ${fmtDate(e.event_date)}` : ""}`);
    }
    for (const [t, ds] of byTitle) {
      lines.push(`- **${clean(t)}**`);
      const shown = ds.slice(0, 6);
      for (const d of shown) lines.push(`  - ${clean(d)}`);
      if (ds.length > shown.length) lines.push(`  - …and ${ds.length - shown.length} more`);
    }
  } else {
    lines.push("No new releases since the last summary.");
  }

  // Coming up in the next 7 days
  const week = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const { data: tracked } = await db.from("titles").select("tmdb_id, title, media_type, digital_release, physical_release, next_episode").eq("tracked", true);
  const lists = await Promise.all(["global", "ph"].map(latestList)) as any[][];

  // Where to watch: one live TMDB lookup per title shown (tracked + both charts), deduped
  const where = new Map<string, Where>();
  const keys = new Map<string, [number, string]>();
  for (const t of tracked ?? []) keys.set(`${t.media_type}:${t.tmdb_id}`, [t.tmdb_id, t.media_type]);
  for (const r of lists.flat()) keys.set(`${r.titles.media_type}:${r.titles.tmdb_id}`, [r.titles.tmdb_id, r.titles.media_type]);
  await Promise.all([...keys].map(async ([k, [id, type]]) => {
    try { where.set(k, await whereToWatch(id, type)); } catch { /* leave blank on lookup failure */ }
  }));

  // Where-to-watch subtitle under an entry (Discord "-# " subtext line); skipped when there's nothing to show
  const pushWhere = (key: string) => {
    const w = where.get(key);
    const s = w ? whereText(w) : "";
    if (s) lines.push(`-# ${clean(s)}`);
  };

  // One entry per title per day: same-day releases are merged, e.g. "(digital, Blu-ray)"
  const upcoming = new Map<string, { date: string; title: string; key: string; tags: string[] }>();
  const addUpcoming = (date: string, t: any, tag: string) => {
    const key = `${t.media_type}:${t.tmdb_id}`;
    const u = upcoming.get(`${date}|${key}`) ?? { date, title: t.title, key, tags: [] };
    u.tags.push(tag);
    upcoming.set(`${date}|${key}`, u);
  };
  for (const t of tracked ?? []) {
    const ne = t.next_episode as any;
    const cinema = where.get(`${t.media_type}:${t.tmdb_id}`)?.phCinema;
    if (ne?.air_date && ne.air_date <= week) addUpcoming(ne.air_date, t, `S${pad(ne.season)}E${pad(ne.episode)}`);
    if (t.digital_release && t.digital_release > today() && t.digital_release <= week) addUpcoming(t.digital_release, t, "digital");
    if (t.physical_release && t.physical_release > today() && t.physical_release <= week) addUpcoming(t.physical_release, t, "Blu-ray");
    if (cinema && cinema > today() && cinema <= week) addUpcoming(cinema, t, "PH cinemas");
  }
  if (upcoming.size) {
    lines.push("", "**Coming this week**");
    // ISO dates kept until display so sorting stays chronological
    const entries = [...upcoming.values()].sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
    // Drop the year when every entry falls in the same year
    const showYear = new Set(entries.map((u) => u.date.slice(0, 4))).size > 1;
    for (const u of entries) {
      const eps = u.tags.filter((x) => /^S\d+E\d+$/.test(x));
      const other = u.tags.filter((x) => !eps.includes(x));
      const tag = [...eps, other.length ? `(${other.join(", ")})` : ""].filter(Boolean).join(" ");
      lines.push(`- ${fmtDate(u.date, showYear)} · **${clean(u.title)}** _${tag}_`);
      pushWhere(u.key);
    }
  }

  for (const [i, label] of ["🌍 Trending Globally", "🇵🇭 Trending in PH"].entries()) {
    const rows = lists[i];
    if (!rows.length) continue;
    lines.push("", `**${label}**`);
    for (const r of rows) {
      const year = r.titles.first_air_or_release?.slice(0, 4);
      lines.push(`${r.rank}. **${clean(r.titles.title)}**${year ? ` _(${year})_` : ""}${r.titles.media_type === "tv" ? " (TV)" : ""}`);
      pushWhere(`${r.titles.media_type}:${r.titles.tmdb_id}`);
    }
  }
  return { lines, evs };
}

async function summary() {
  const { lines, evs } = await buildSummary();
  const result = await broadcast(toHtml(lines), lines.join("\n"));
  if (evs.length) {
    await db.from("release_events").update({ notified_at: new Date().toISOString() }).in("id", evs.map((e: any) => e.id));
  }
  return { ...result, new_events: evs.length };
}

// Dry run: build the summary and return it. Sends nothing, marks nothing notified.
// With send=true it also posts the preview (labelled as such) to the alert channels, still marking nothing.
async function preview(send = false) {
  const { lines, evs } = await buildSummary();
  if (!send) return { new_events: evs.length, markdown: lines.join("\n") };
  const out = ["-# Layout preview, not the weekly summary. No releases were marked as sent.", ...lines];
  return { ...(await broadcast(toHtml(out), out.join("\n"), true)), new_events: evs.length };
}

// Strip markup characters from titles so they can't break bold/italics on either platform
const clean = (s: string) => s.replace(/[*_~`|]/g, "");

async function testAlerts() {
  return await broadcast(
    "✅ <b>Release tracker connected.</b> You'll get a weekly summary here.",
    "✅ **Release tracker connected.** You'll get a weekly summary here.",
  );
}

// ---------- HTTP entry ----------
Deno.serve(async (req) => {
  const secret = await getSetting("cron_secret");
  if (!secret || req.headers.get("x-cron-secret") !== secret) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }
  const url = new URL(req.url);
  let action = url.searchParams.get("action");
  if (!action && req.method === "POST") { try { action = (await req.json()).action; } catch { /* empty body */ } }
  const started = Date.now();
  try {
    let info: any;
    if (action === "refresh") info = await refresh();
    else if (action === "summary") info = await summary();
    else if (action === "preview") info = await preview();
    else if (action === "preview_send") info = await preview(true);
    else if (action === "test" || action === "telegram") info = await testAlerts();
    else return new Response(JSON.stringify({ error: "unknown action" }), { status: 400 });
    info.ms = Date.now() - started;
    await db.from("run_log").insert({ job: action, ok: true, info });
    return Response.json(info);
  } catch (e) {
    await db.from("run_log").insert({ job: action ?? "?", ok: false, info: { error: String(e) } });
    return Response.json({ error: String(e) }, { status: 500 });
  }
});
