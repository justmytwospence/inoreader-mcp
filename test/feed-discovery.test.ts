import { test } from "node:test";
import assert from "node:assert/strict";
import {
  discoverFeedLinks,
  isPrivateAddress,
  judge,
  looksLikeFeed,
  normalizeUrl,
  overlapCount,
  parseFeed,
  sameSite,
} from "../src/feed-discovery.js";

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Jane &amp; Co</title>
<item><title><![CDATA[Moving to a static site]]></title><link>https://jane.dev/posts/static/</link><pubDate>Tue, 14 Oct 2026 10:00:00 GMT</pubDate></item>
<item><title>Older post</title><link>https://jane.dev/posts/old</link><pubDate>Mon, 01 Sep 2025 10:00:00 GMT</pubDate></item>
</channel></rss>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Jane</title>
<entry><title>Moving to a static site</title><link rel="alternate" href="https://www.jane.dev/posts/static"/><updated>2026-10-14T10:00:00Z</updated></entry>
<entry><title>Brand new</title><link href="https://jane.dev/posts/new"/><published>2026-10-20T10:00:00Z</published></entry>
</feed>`;

test("RSS and Atom parse to titles, links and the newest date", () => {
  const r = parseFeed(RSS);
  assert.equal(r.title, "Jane & Co");
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].title, "Moving to a static site");
  assert.equal(r.items[0].link, "https://jane.dev/posts/static/");
  assert.equal(r.newest, "2026-10-14T10:00:00.000Z");

  const a = parseFeed(ATOM);
  assert.deepEqual(a.items.map((i) => i.link), ["https://www.jane.dev/posts/static", "https://jane.dev/posts/new"]);
  assert.equal(a.newest, "2026-10-20T10:00:00.000Z");
});

test("a feed is recognised by its root element, an HTML page is not", () => {
  assert.ok(looksLikeFeed(RSS));
  assert.ok(looksLikeFeed(ATOM));
  assert.ok(!looksLikeFeed("<!doctype html><html><head><title>Not found</title></head></html>"));
});

test("advertised feeds are found in any attribute order, resolved, and comment feeds skipped", () => {
  const html = `<html><head>
    <link href="/feed.xml" rel="alternate" type="application/atom+xml" title="Posts">
    <link rel='alternate' type='application/rss+xml' href='https://jane.dev/comments/feed/'>
    <link rel="stylesheet" href="/style.css">
    <link type="application/rss+xml" rel="alternate" href="podcast.rss">
  </head></html>`;
  assert.deepEqual(discoverFeedLinks(html, "https://jane.dev/blog/"), [
    "https://jane.dev/feed.xml",
    "https://jane.dev/blog/podcast.rss",
  ]);
});

test("the same post is recognised across www, trailing slashes and title punctuation", () => {
  const known = parseFeed(RSS).items;
  const candidate = parseFeed(ATOM).items;
  assert.equal(overlapCount(known, candidate), 1);
  assert.equal(normalizeUrl("https://www.Jane.dev/posts/static/?utm=x"), "jane.dev/posts/static");
  // Short generic titles do not count as evidence on their own.
  assert.equal(overlapCount([{ title: "Update", link: null, date: null }], [{ title: "Update", link: null, date: null }]), 0);
});

test("confidence: shared posts or a redirect is high, same site alone is medium", () => {
  assert.equal(judge({ overlap: 2, redirectedFromOld: false, sameSite: false, items: 10 }).confidence, "high");
  assert.equal(judge({ overlap: 0, redirectedFromOld: true, sameSite: false, items: 10 }).confidence, "high");
  assert.equal(judge({ overlap: 0, redirectedFromOld: false, sameSite: true, items: 10 }).confidence, "medium");
  assert.equal(judge({ overlap: 0, redirectedFromOld: false, sameSite: true, items: 0 }).confidence, "low");
  assert.equal(judge({ overlap: 0, redirectedFromOld: false, sameSite: false, items: 10 }).confidence, "low");
});

test("sites match across www and subdomains, not across different domains", () => {
  assert.ok(sameSite("https://www.jane.dev/feed", "https://jane.dev"));
  assert.ok(sameSite("https://blog.jane.dev/rss", "https://jane.dev/"));
  assert.ok(!sameSite("https://jane.dev/rss", "https://notjane.dev/"));
});

test("private, loopback and link-local addresses are refused", () => {
  for (const ip of ["10.0.0.5", "127.0.0.1", "172.20.1.1", "192.168.1.10", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
    assert.ok(isPrivateAddress(ip), ip);
  }
  for (const ip of ["1.1.1.1", "172.32.0.1", "2606:4700::1111"]) assert.ok(!isPrivateAddress(ip), ip);
});
