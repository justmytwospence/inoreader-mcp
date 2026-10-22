import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Finding where a broken feed went.
 *
 * Feeds break in a few recurring ways: the site moved its feed (Ghost /rss/ to /feed.xml,
 * WordPress to a static generator), the whole site moved domain and redirects, or the
 * feed address now serves an HTML page. In each case the new feed is usually advertised
 * by the site itself (<link rel="alternate">), sits at a conventional path, or is where
 * the old address redirects.
 *
 * Finding *a* feed is easy; finding the *same publication's* feed is the point. The
 * strongest evidence is overlap with the posts Inoreader already stored from the old
 * feed: a candidate that carries the same post links or titles is the same publication.
 * A redirect from the old feed address is nearly as strong. Being on the same site is
 * only medium evidence -- a site can carry several feeds (comments, a podcast, a tag).
 */

export interface FeedItem {
  title: string;
  link: string | null;
  date: string | null;
}

export interface FeedSnapshot {
  title: string | null;
  items: FeedItem[];
  newest: string | null;
}

export type Confidence = "high" | "medium" | "low";

const FEED_ROOT = /<(rss|feed|rdf:RDF)[\s>]/i;

export function looksLikeFeed(body: string): boolean {
  return FEED_ROOT.test(body.slice(0, 5000));
}

const decode = (s: string): string =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&")
    .trim();

const tag = (block: string, name: string): string | null => {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) : null;
};

const attr = (el: string, name: string): string | null => {
  const m = el.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
};

/** RSS 2.0, RSS 1.0 (RDF) and Atom, by regex: tolerant of the malformed XML real feeds serve. */
export function parseFeed(body: string): FeedSnapshot {
  const parts = body.split(/<(?:item|entry)[\s>]/i);
  const head = parts[0];
  const items: FeedItem[] = [];
  for (const raw of parts.slice(1)) {
    const block = raw.split(/<\/(?:item|entry)>/i)[0];
    let link = tag(block, "link");
    if (!link) {
      // Atom: <link rel="alternate" href="..."/> (rel defaults to alternate)
      const links = block.match(/<link\b[^>]*>/gi) ?? [];
      const alt = links.find((l) => !attr(l, "rel") || attr(l, "rel") === "alternate");
      link = alt ? attr(alt, "href") : null;
    }
    const date = tag(block, "pubDate") ?? tag(block, "published") ?? tag(block, "updated") ?? tag(block, "dc:date");
    items.push({ title: tag(block, "title") ?? "", link: link || null, date });
  }
  const times = items.map((i) => (i.date ? Date.parse(i.date) : NaN)).filter((t) => !Number.isNaN(t));
  return {
    title: tag(head, "title"),
    items,
    newest: times.length ? new Date(Math.max(...times)).toISOString() : null,
  };
}

const FEED_TYPES = /^application\/(?:rss|atom|rdf|feed)\+(?:xml|json)$|^application\/(?:rss|atom)$|^text\/xml$/i;
const COMMENT_FEED = /comments?\/feed|\/comments\b|comment-?feed/i;

/** Feeds a page advertises with <link rel="alternate" type="application/rss+xml" href>. */
export function discoverFeedLinks(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  for (const el of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = (attr(el, "rel") ?? "").toLowerCase().split(/\s+/);
    const type = attr(el, "type") ?? "";
    const href = attr(el, "href");
    if (!href || !rel.includes("alternate") || !FEED_TYPES.test(type)) continue;
    let url: string;
    try {
      url = new URL(decode(href), baseUrl).toString();
    } catch {
      continue;
    }
    if (COMMENT_FEED.test(url) || out.includes(url)) continue;
    out.push(url);
  }
  return out;
}

/** Conventional feed paths, tried on a site when it advertises none. */
export const COMMON_FEED_PATHS = [
  "/feed",
  "/feed/",
  "/rss",
  "/rss/",
  "/rss.xml",
  "/feed.xml",
  "/atom.xml",
  "/index.xml",
  "/feeds/posts/default",
  "/blog/feed",
  "/blog/rss.xml",
  "/blog/index.xml",
];

/** Comparable form of a URL: https, no www, no trailing slash, no query or fragment. */
export function normalizeUrl(u: string): string {
  try {
    const x = new URL(u);
    const host = x.hostname.toLowerCase().replace(/^www\./, "");
    const path = x.pathname.replace(/\/+$/, "");
    return `${host}${path}`;
  } catch {
    return u.trim().toLowerCase();
  }
}

const hostOf = (u: string): string | null => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
};

/** Same host, or one is a subdomain of the other (blog.example.com / example.com). */
export function sameSite(a: string, b: string): boolean {
  const ha = hostOf(a);
  const hb = hostOf(b);
  if (!ha || !hb) return false;
  return ha === hb || ha.endsWith(`.${hb}`) || hb.endsWith(`.${ha}`);
}

const normTitle = (t: string): string => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** How many of the candidate's posts Inoreader already stored from the old feed. */
export function overlapCount(known: FeedItem[], candidate: FeedItem[]): number {
  const links = new Set(known.map((k) => k.link).filter((l): l is string => !!l).map(normalizeUrl));
  const titles = new Set(known.map((k) => normTitle(k.title)).filter((t) => t.length >= 12));
  let n = 0;
  for (const c of candidate) {
    if ((c.link && links.has(normalizeUrl(c.link))) || titles.has(normTitle(c.title))) n++;
  }
  return n;
}

export function judge(c: { overlap: number; redirectedFromOld: boolean; sameSite: boolean; items: number }): {
  confidence: Confidence;
  reason: string;
} {
  if (c.overlap > 0) {
    return { confidence: "high", reason: `carries ${c.overlap} post${c.overlap > 1 ? "s" : ""} Inoreader stored from the old feed` };
  }
  if (c.redirectedFromOld && c.items > 0) return { confidence: "high", reason: "the old feed address redirects here" };
  if (c.sameSite && c.items > 0) return { confidence: "medium", reason: "same site, but no posts in common with the old feed" };
  return { confidence: "low", reason: c.items > 0 ? "a different site" : "no posts" };
}

// ---- network --------------------------------------------------------------------------

/** Loopback, private, link-local, CGNAT, unique-local and unspecified addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
  return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb");
}

/**
 * Only public http(s) addresses. This server sits on the homelab's networks; without this
 * check, any MCP client could make it fetch internal services and read their answers.
 */
export async function assertPublicUrl(url: string): Promise<void> {
  const x = new URL(url);
  if (x.protocol !== "http:" && x.protocol !== "https:") throw new Error(`not http(s): ${url}`);
  const host = x.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new Error(`refusing a private address: ${x.hostname}`);
}

export interface FetchResult {
  ok: boolean;
  status: number | null;
  finalUrl: string;
  body: string;
  error?: string;
}

const UA = "Mozilla/5.0 (compatible; inoreader-mcp feed repair; +https://github.com/justmytwospence/inoreader-mcp)";

/** GET with redirects followed by hand, so every hop is checked against assertPublicUrl. */
export async function fetchPublic(url: string, timeoutMs = 15000, maxBytes = 2_000_000): Promise<FetchResult> {
  let current = url;
  try {
    for (let hop = 0; hop <= 5; hop++) {
      await assertPublicUrl(current);
      const res = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "User-Agent": UA, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, text/html;q=0.8, */*;q=0.5" },
      });
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        current = new URL(loc, current).toString();
        continue;
      }
      const body = (await res.text()).slice(0, maxBytes);
      return { ok: res.ok, status: res.status, finalUrl: current, body };
    }
    return { ok: false, status: null, finalUrl: current, body: "", error: "too many redirects" };
  } catch (e) {
    const err = e as { cause?: { code?: string }; message?: string };
    return { ok: false, status: null, finalUrl: current, body: "", error: err.cause?.code ?? err.message ?? String(e) };
  }
}
