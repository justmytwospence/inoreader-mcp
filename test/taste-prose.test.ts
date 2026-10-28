import assert from "node:assert/strict";
import { test } from "node:test";

const { proseStats, domainOf, normalizeDomain, domainMatches } = await import("../src/taste/prose.js");
const { cleanHtml } = await import("../src/taste/text.js");

const sentence = "Most people overrate how much a single measurement tells them about a system they barely understand.";
const prose = (n: number) => Array.from({ length: n }, () => `${sentence} ${sentence}`).join("\n\n");

test("an essay-like text has prose paragraphs and a high prose ratio", () => {
  const s = proseStats(prose(3));
  assert.equal(s.prose_paragraphs, 3);
  assert.equal(s.prose_ratio, 1);
});

test("README-like and product-like texts have few prose paragraphs", () => {
  const readme = cleanHtml(
    "<h1>tool</h1><p>A fast thing for your terminal</p><ul><li>install it</li><li>run it</li></ul><pre>npm i tool</pre><p>MIT licensed</p>",
  );
  assert.equal(proseStats(readme.text).prose_paragraphs, 0);
  const product = "Ship faster.\n\nBuilt for teams.\n\nPricing\n\nStart free today\n\n" + "Feature one, feature two, feature three and more ".repeat(6);
  const p = proseStats(product);
  assert.equal(p.prose_paragraphs, 0, "a long run-on list without sentence punctuation is not prose");
});

test("a teaser is too short to be prose", () => {
  assert.deepEqual(proseStats("Read the full post on our site"), { prose_paragraphs: 0, prose_ratio: 0 });
  assert.deepEqual(proseStats(""), { prose_paragraphs: 0, prose_ratio: 0 });
});

test("full text and its capped opening are judged the same way (only the opening counts)", () => {
  const full = cleanHtml(`<p>${prose(12).split("\n\n").join("</p><p>")}</p>`);
  assert.ok(full.text.length > full.opening.length);
  assert.deepEqual(proseStats(full.text), proseStats(full.opening));
});

test("domains: hosts are normalized and subdomains match", () => {
  assert.equal(domainOf("https://www.Example.com/a"), "example.com");
  assert.equal(domainOf("not a url"), "");
  assert.equal(normalizeDomain(" WWW.GitHub.com. "), "github.com");
  assert.equal(normalizeDomain("*.substack.com"), "substack.com");
  assert.equal(normalizeDomain("github"), undefined);
  assert.equal(normalizeDomain("https://github.com"), undefined);
  assert.ok(domainMatches("gist.github.com", ["github.com"]));
  assert.ok(domainMatches("github.com", ["github.com"]));
  assert.ok(!domainMatches("notgithub.com", ["github.com"]));
});
