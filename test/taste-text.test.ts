import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FULL_TEXT_CAP, OPENING_CHARS, cleanHtml, countWords, decodeEntities, embedInput, extractHeadings, htmlToText, makeOpening,
} from "../src/taste/text.js";

test("htmlToText keeps paragraphs, drops tags, scripts and comments", () => {
  const html = `<div><style>p{color:red}</style><script>alert(1)</script><!-- hidden -->
    <p>First <b>bold</b> and <a href="/x">linked</a> text.</p><p>Second&nbsp;paragraph &amp; more.</p></div>`;
  assert.equal(htmlToText(html), "First bold and linked text.\n\nSecond paragraph & more.");
});

test("htmlToText turns br and list items into line breaks", () => {
  assert.equal(htmlToText("<ul><li>one</li><li>two</li></ul>a<br>b"), "one\n\ntwo\n\na\n\nb");
});

test("decodeEntities handles named, decimal and hex references and leaves unknown ones", () => {
  assert.equal(decodeEntities("a &lt; b &amp;&amp; c &#8212; d &#x2019;s &bogus; &#0;"), "a < b && c \u2014 d \u2019s &bogus; ");
});

test("extractHeadings returns h2 and h3 only, de-duplicated, without markup", () => {
  const html = "<h1>Title</h1><h2>First <em>part</em></h2><p>x</p><h3>Detail</h3><h2>First part</h2><h4>Skip</h4><script><h2>no</h2></script>";
  assert.deepEqual(extractHeadings(html), ["First part", "Detail"]);
});

test("extractHeadings bounds heading length and count", () => {
  const long = "x".repeat(300);
  const many = Array.from({ length: 40 }, (_, i) => `<h2>H${i}</h2>`).join("");
  assert.equal(extractHeadings(`<h2>${long}</h2>`)[0].length, 140);
  assert.equal(extractHeadings(many).length, 24);
});

test("countWords counts whitespace-separated tokens", () => {
  assert.equal(countWords("one two\nthree\n\nfour"), 4);
  assert.equal(countWords(""), 0);
});

test("makeOpening returns short text whole and cuts long text at a sentence end", () => {
  assert.equal(makeOpening("Short text."), "Short text.");
  const sentence = "This is a sentence of some length. ";
  const text = sentence.repeat(60);
  const opening = makeOpening(text);
  assert.ok(opening.length <= OPENING_CHARS);
  assert.ok(opening.endsWith("."));
  assert.ok(opening.length > OPENING_CHARS * 0.6);
});

test("makeOpening cuts at a word when there is no late sentence end", () => {
  const text = "word ".repeat(400);
  const opening = makeOpening(text);
  assert.ok(opening.length <= OPENING_CHARS);
  assert.ok(opening.endsWith("word"));
});

test("cleanHtml reports the whole word count but caps the stored text", () => {
  const body = `<h2>Intro</h2>${"<p>" + "word ".repeat(10) + "</p>".repeat(1)}`.repeat(1) + ("<p>" + "alpha ".repeat(5000) + "</p>");
  const c = cleanHtml(body);
  assert.equal(c.headings[0], "Intro");
  assert.ok(c.words > 5000);
  assert.ok(c.text.length <= FULL_TEXT_CAP);
  assert.ok(c.opening.length <= OPENING_CHARS);
});

test("cleanHtml of nothing is empty", () => {
  assert.deepEqual(cleanHtml(""), { text: "", opening: "", headings: [], words: 0 });
});

test("embedInput is the title then the opening on one line", () => {
  assert.equal(embedInput("  A title ", "First\n\nsecond   line"), "A title\n\nFirst second line");
});
