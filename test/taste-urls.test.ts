import assert from "node:assert/strict";
import { test } from "node:test";
import { articleUrl, normalizeUrl } from "../src/taste/urls.js";

const cases: Array<[string, string, string | null]> = [
  ["http becomes https", "http://example.com/post", "https://example.com/post"],
  ["host is lowercased", "https://EXAMPLE.com/Post", "https://example.com/Post"],
  ["www is removed", "https://www.example.com/post", "https://example.com/post"],
  ["fragment is dropped", "https://example.com/post#section-2", "https://example.com/post"],
  ["trailing slash is dropped", "https://example.com/post/", "https://example.com/post"],
  ["root keeps no slash", "https://example.com/", "https://example.com"],
  ["default port is dropped", "https://example.com:443/post", "https://example.com/post"],
  ["other port stays", "http://example.com:8080/post", "https://example.com:8080/post"],
  ["/amp is dropped", "https://example.com/post/amp", "https://example.com/post"],
  ["/amp/ is dropped", "https://example.com/post/amp/", "https://example.com/post"],
  ["an amp inside a word stays", "https://example.com/camp", "https://example.com/camp"],
  ["utm parameters are dropped", "https://example.com/post?utm_source=rss&utm_medium=feed&utm_campaign=x", "https://example.com/post"],
  ["fbclid and gclid are dropped", "https://example.com/post?fbclid=abc&gclid=def&id=7", "https://example.com/post?id=7"],
  ["mc_ parameters are dropped", "https://example.com/post?mc_cid=1&mc_eid=2", "https://example.com/post"],
  ["ref, ref_src and referrer are dropped", "https://example.com/post?ref=hn&ref_src=tw&referrer=x&id=2", "https://example.com/post?id=2"],
  ["refresh and reference are real parameters", "https://example.com/post?refresh=1&reference=2", "https://example.com/post?reference=2&refresh=1"],
  ["Substack r is dropped on substack.com", "https://writer.substack.com/p/title?r=1a2b3&utm_campaign=post", "https://writer.substack.com/p/title"],
  ["Substack r is dropped when utm_source names substack", "https://www.example.org/p/title?utm_source=substack&r=4abcd", "https://example.org/p/title"],
  ["r stays on other sites", "https://example.com/search?r=5", "https://example.com/search?r=5"],
  ["remaining parameters are sorted", "https://example.com/p?b=2&a=2&a=1", "https://example.com/p?a=1&a=2&b=2"],
  ["empty query leaves no question mark", "https://example.com/post?utm_source=x", "https://example.com/post"],
  ["surrounding whitespace is trimmed", "  https://example.com/post  ", "https://example.com/post"],
  ["the same page from different routes agrees", "https://www.example.com/post/?utm_source=a#x", "https://example.com/post"],
  ["a relative URL is not a page", "/post", null],
  ["mailto is not a page", "mailto:a@example.com", null],
  ["ftp is not a page", "ftp://example.com/file", null],
  ["empty is null", "", null],
];

for (const [name, input, expected] of cases) {
  test(`normalizeUrl: ${name}`, () => assert.equal(normalizeUrl(input), expected));
}

test("normalizeUrl: null and undefined are null", () => {
  assert.equal(normalizeUrl(undefined), null);
  assert.equal(normalizeUrl(null), null);
});

test("articleUrl prefers canonical over alternate", () => {
  assert.equal(articleUrl({ canonical: [{ href: "https://a.example/c" }], alternate: [{ href: "https://a.example/a" }] }), "https://a.example/c");
  assert.equal(articleUrl({ alternate: [{ href: "https://a.example/a" }] }), "https://a.example/a");
  assert.equal(articleUrl({}), undefined);
});
