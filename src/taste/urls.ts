// The item key: one normalized URL per article, so the same page saved through
// different routes (a feed item, a Karakeep bookmark, a shared link with tracking
// parameters) is one row with several signals.

/** Parameters that identify a visit or a campaign, never a page. */
const TRACKING_PARAMS = new Set([
  "fbclid", "gclid", "gclsrc", "dclid", "gbraid", "wbraid", "msclkid", "yclid", "twclid", "igshid", "igsh",
  "mkt_tok", "_hsenc", "_hsmi", "__hstc", "__hssc", "__hsfp", "hsctatracking", "vero_id", "vero_conv",
  "oly_enc_id", "oly_anon_id", "s_cid", "s_kwcid", "ocid", "cmpid", "ncid", "spm", "sr_share", "trk", "trkid",
  "at_medium", "at_campaign", "at_custom1", "pk_campaign", "pk_kwd", "mc_cid", "mc_eid", "amp", "outputtype",
]);

/** utm_*, mc_*, ref, ref_*, ref_src, ref_url, referrer. Not `refresh`, `reference`. */
const TRACKING_PATTERN = /^(utm_.*|mc_.*|ref|ref_.*|refsrc|referrer)$/i;

function isTracking(name: string): boolean {
  const n = name.toLowerCase();
  return TRACKING_PARAMS.has(n) || TRACKING_PATTERN.test(n);
}

/**
 * Normalizes an article URL, or returns null for anything that is not an http(s) URL.
 *
 * https, lowercased host without `www.`, no fragment, no default port, no trailing
 * slash or `/amp`, tracking parameters dropped, the rest sorted. Substack's `r`
 * (a referral code) is dropped on substack.com and wherever `utm_source` names
 * substack, since `r` alone can be a real parameter elsewhere.
 */
export function normalizeUrl(input: string | undefined | null): string | null {
  if (!input) return null;
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (!host) return null;

  let path = u.pathname.replace(/\/+$/, "");
  path = path.replace(/\/amp$/i, "");
  path = path.replace(/\/+$/, "");

  const substack = host === "substack.com" || host.endsWith(".substack.com") ||
    /substack/i.test(u.searchParams.get("utm_source") ?? "");
  const kept: Array<[string, string]> = [];
  for (const [k, v] of u.searchParams) {
    if (isTracking(k)) continue;
    if (substack && k === "r") continue;
    kept.push([k, v]);
  }
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const query = kept.length ? `?${kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}` : "";
  const port = u.port && !((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80"))
    ? `:${u.port}` : "";
  return `https://${host}${port}${path}${query}`;
}

/** An article's own URL: canonical first, else alternate. */
export function articleUrl(item: { canonical?: Array<{ href: string }>; alternate?: Array<{ href: string }> }): string | undefined {
  return item.canonical?.[0]?.href || item.alternate?.[0]?.href || undefined;
}
