import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { apiGet, apiPost } from "../api.js";
import {
  COMMON_FEED_PATHS,
  discoverFeedLinks,
  fetchPublic,
  judge,
  looksLikeFeed,
  normalizeUrl,
  overlapCount,
  parseFeed,
  sameSite,
  type Confidence,
  type FeedItem,
} from "../feed-discovery.js";
import type { InoreaderSubscription, StreamContentsResponse, SubscriptionListResponse } from "../types.js";

const MAX_CANDIDATES = 15;
const RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

interface Candidate {
  feed_url: string;
  title: string | null;
  items: number;
  newest_item: string | null;
  shared_posts: number;
  same_site: boolean;
  found_via: string;
  confidence: Confidence;
  reason: string;
}

const text = (value: unknown, isError = false) => ({
  isError,
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

const listSubscriptions = async (): Promise<InoreaderSubscription[]> =>
  (await apiGet<SubscriptionListResponse>("/reader/api/0/subscription/list", { output: "json" })).subscriptions;

const originOf = (u: string): string | null => {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};

export function registerRepairTools(server: McpServer): void {
  server.registerTool(
    "find_feed_replacement",
    {
      annotations: { readOnlyHint: true },
      description:
        "Find a working feed for a subscription whose feed address is broken. Checks where the old address redirects, the feeds the site advertises (<link rel=alternate>), and conventional feed paths, then compares each candidate with the posts Inoreader stored from the old feed. confidence 'high' means the candidate carries posts from the old feed or the old address redirects to it; 'medium' means same site but no shared posts; 'low' is anything else. `recommended` is the best high-confidence candidate, or null. Makes NO changes -- apply one with replace_feed. Costs 2 Zone 1 requests, plus up to ~30 fetches of the site itself (not Inoreader).",
      inputSchema: z.object({
        stream_id: z.string().describe("Stream ID of the subscription, e.g. feed/https://example.com/rss"),
      }),
    },
    async (params) => {
      const sub = (await listSubscriptions()).find((s) => s.id === params.stream_id);
      if (!sub) return text({ error: `no subscription ${params.stream_id}` }, true);
      const oldUrl = sub.url || params.stream_id.replace(/^feed\//, "");

      let known: FeedItem[] = [];
      try {
        const stored = await apiGet<StreamContentsResponse>(
          `/reader/api/0/stream/contents/${encodeURIComponent(params.stream_id)}`,
          { n: "30" }
        );
        known = (stored.items ?? []).map((i) => ({
          title: i.title ?? "",
          link: i.canonical?.[0]?.href ?? i.alternate?.[0]?.href ?? null,
          date: null,
        }));
      } catch {
        known = [];
      }

      // Where candidates came from: a redirect of the old address is evidence in itself.
      const found = new Map<string, { via: string; redirectedFromOld: boolean }>();
      const add = (url: string, via: string, redirectedFromOld = false) => {
        if (normalizeUrl(url) === normalizeUrl(oldUrl)) return;
        const prev = found.get(url);
        if (!prev) found.set(url, { via, redirectedFromOld });
        else if (redirectedFromOld) prev.redirectedFromOld = true;
      };

      const old = await fetchPublic(oldUrl);
      const oldWorks = old.ok && looksLikeFeed(old.body);
      const oldStatus = old.error ?? (old.status !== null ? `HTTP ${old.status}` : "no answer");
      if (oldWorks && normalizeUrl(old.finalUrl) !== normalizeUrl(oldUrl)) add(old.finalUrl, "old address redirects here", true);

      // The site: its own page (as Inoreader knows it), the old feed's origin, and wherever
      // those redirect to now -- a site that moved domain usually redirects its home page.
      const sites = new Set<string>();
      for (const page of [sub.htmlUrl, originOf(sub.htmlUrl ?? ""), originOf(oldUrl), old.ok ? null : originOf(old.finalUrl)]) {
        if (page) sites.add(page);
      }
      const siteOrigins = new Set<string>();
      for (const page of sites) {
        const r = await fetchPublic(page);
        const origin = originOf(r.finalUrl);
        if (origin) siteOrigins.add(origin);
        if (r.ok && looksLikeFeed(r.body)) add(r.finalUrl, "the site address serves a feed");
        else if (r.ok) for (const link of discoverFeedLinks(r.body, r.finalUrl)) add(link, `advertised by ${r.finalUrl}`);
      }
      if (found.size === 0) {
        for (const origin of siteOrigins) for (const p of COMMON_FEED_PATHS) add(origin + p, `conventional path on ${origin}`);
      }

      const candidates: Candidate[] = [];
      for (const [url, meta] of [...found].slice(0, MAX_CANDIDATES * 2)) {
        if (candidates.length >= MAX_CANDIDATES) break;
        const r = await fetchPublic(url);
        if (!r.ok || !looksLikeFeed(r.body)) continue;
        const snap = parseFeed(r.body);
        const onSite = [oldUrl, sub.htmlUrl ?? "", ...siteOrigins].some((s) => s && sameSite(r.finalUrl, s));
        const overlap = overlapCount(known, snap.items);
        const verdict = judge({ overlap, redirectedFromOld: meta.redirectedFromOld, sameSite: onSite, items: snap.items.length });
        if (candidates.some((c) => normalizeUrl(c.feed_url) === normalizeUrl(r.finalUrl))) continue;
        candidates.push({
          feed_url: r.finalUrl,
          title: snap.title,
          items: snap.items.length,
          newest_item: snap.newest,
          shared_posts: overlap,
          same_site: onSite,
          found_via: meta.via,
          confidence: verdict.confidence,
          reason: verdict.reason,
        });
      }
      candidates.sort((a, b) => RANK[a.confidence] - RANK[b.confidence] || b.shared_posts - a.shared_posts || (b.newest_item ?? "").localeCompare(a.newest_item ?? ""));
      const recommended = candidates.find((c) => c.confidence === "high") ?? null;

      return text({
        stream_id: params.stream_id,
        title: sub.title,
        folders: sub.categories.map((c) => c.label),
        old_feed: { url: oldUrl, works: oldWorks, status: oldWorks ? "ok" : oldStatus },
        posts_known_from_old_feed: known.length,
        candidates,
        recommended: recommended ? recommended.feed_url : null,
      });
    }
  );

  server.registerTool(
    "replace_feed",
    {
      description:
        "Replace a subscription with a different feed URL, keeping its title and folders: subscribe to the new feed, put it in the same folders under the same title, confirm that landed, and only then unsubscribe the old one. If the new feed is already subscribed, its folders are topped up and the old one is removed. Read state of the old feed is not carried over. Use with find_feed_replacement. Costs 2-3 Zone 2 requests and 3 Zone 1 requests.",
      inputSchema: z.object({
        stream_id: z.string().describe("Stream ID of the subscription to replace"),
        new_feed_url: z.string().url().describe("Feed URL to subscribe to instead"),
      }),
    },
    async (params) => {
      const subs = await listSubscriptions();
      const old = subs.find((s) => s.id === params.stream_id);
      if (!old) return text({ error: `no subscription ${params.stream_id}` }, true);
      const folders = old.categories.map((c) => c.label);
      if (normalizeUrl(params.new_feed_url) === normalizeUrl(old.url || old.id.slice(5))) {
        return text({ error: "the new feed URL is the old one" }, true);
      }

      const existing = subs.find((s) => normalizeUrl(s.url || s.id.slice(5)) === normalizeUrl(params.new_feed_url));
      let newId = existing?.id;
      if (!newId) {
        const added = await apiPost<{ streamId?: string; numResults?: number }>("/reader/api/0/subscription/quickadd", {
          quickadd: params.new_feed_url,
        });
        newId = added && typeof added === "object" ? added.streamId : undefined;
        if (!newId) return text({ error: `Inoreader did not subscribe to ${params.new_feed_url}`, answer: added }, true);
      }
      const edit = new URLSearchParams({ ac: "edit", s: newId });
      if (!existing) edit.set("t", old.title);
      for (const f of folders) edit.append("a", `user/-/label/${f}`);
      await apiPost<string>("/reader/api/0/subscription/edit", edit, undefined, { expectOk: true });

      // Confirm the replacement before touching the old subscription.
      const after = await listSubscriptions();
      const now = after.find((s) => s.id === newId);
      const have = new Set((now?.categories ?? []).map((c) => c.label.toLowerCase()));
      const missing = folders.filter((f) => !have.has(f.toLowerCase()));
      if (!now || missing.length) {
        return text({ error: "the new subscription did not land as asked; the old one was kept", new_stream_id: newId, missing_folders: missing }, true);
      }

      await apiPost<string>("/reader/api/0/subscription/edit", { ac: "unsubscribe", s: old.id });
      const gone = !(await listSubscriptions()).some((s) => s.id === old.id);
      return text(
        {
          old: { stream_id: old.id, unsubscribed: gone },
          new: { stream_id: newId, title: now.title, folders: now.categories.map((c) => c.label), was_already_subscribed: !!existing },
        },
        !gone
      );
    }
  );
}
