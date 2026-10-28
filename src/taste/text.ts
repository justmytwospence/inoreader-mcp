// HTML to text for the stored feed content (or a Karakeep crawl). No parser
// dependency: feed HTML is loose, and the output only feeds an embedding, an
// excerpt and a word count.

export const OPENING_CHARS = 1200;
/** Items outside the widest tier keep their cleaned text, capped here, for longer excerpts. */
export const FULL_TEXT_CAP = 20_000;
const MAX_HEADINGS = 24;
const MAX_HEADING_CHARS = 140;

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", hellip: "...",
  lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', copy: "(c)", reg: "(r)", trade: "(tm)", laquo: '"', raquo: '"',
  bull: "*", middot: "*", times: "x", eacute: "e", egrave: "e", agrave: "a", uuml: "u", ouml: "o", auml: "a",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return "";
      try {
        return String.fromCodePoint(code);
      } catch {
        return "";
      }
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const DROP_BLOCKS = /<(script|style|noscript|svg|template|iframe|head|button|form|select|textarea|object|canvas)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const BLOCK_END = /<\/(p|h[1-6]|blockquote|pre|div|section|article|figure|figcaption|li|tr|table|ul|ol|header|footer|aside|dd|dt)\s*>|<(br|hr)\b[^>]*>/gi;

function squash(s: string): string {
  return s.replace(/[ \t\r\f\v\u00a0]+/g, " ").trim();
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

/** The h2/h3 headings, in order, de-duplicated and bounded. */
export function extractHeadings(html: string): string[] {
  const clean = html.replace(/<!--[\s\S]*?-->/g, "").replace(DROP_BLOCKS, "");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of clean.matchAll(/<h([23])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)) {
    const text = squash(decodeEntities(stripTags(m[2])).replace(/\s+/g, " "));
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text.length > MAX_HEADING_CHARS ? `${text.slice(0, MAX_HEADING_CHARS - 3)}...` : text);
    if (out.length >= MAX_HEADINGS) break;
  }
  return out;
}

/** Visible text, paragraphs separated by a blank line. */
export function htmlToText(html: string): string {
  const noisy = html.replace(/<!--[\s\S]*?-->/g, "").replace(DROP_BLOCKS, "");
  const withBreaks = noisy.replace(BLOCK_END, "\n");
  const text = decodeEntities(stripTags(withBreaks));
  return text
    .split("\n")
    .map(squash)
    .filter((l) => l.length > 0)
    .join("\n\n");
}

export function countWords(text: string): number {
  const m = text.match(/\S+/g);
  return m ? m.length : 0;
}

/** The first ~`max` characters, cut at a sentence end if one falls late enough, else at a word. */
export function makeOpening(text: string, max = OPENING_CHARS): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sentence = Math.max(
    cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "),
    cut.lastIndexOf(".\n"), cut.lastIndexOf("?\n"), cut.lastIndexOf("!\n"),
  );
  if (sentence >= max * 0.6) return cut.slice(0, sentence + 1).trim();
  const space = cut.search(/\s\S*$/);
  return (space > 0 ? cut.slice(0, space) : cut).trim();
}

export interface CleanedText {
  /** Cleaned text, capped at FULL_TEXT_CAP. */
  text: string;
  opening: string;
  headings: string[];
  /** Words in the whole cleaned text, before the cap. */
  words: number;
}

export function cleanHtml(html: string): CleanedText {
  const full = htmlToText(html);
  return {
    text: full.length > FULL_TEXT_CAP ? full.slice(0, FULL_TEXT_CAP) : full,
    opening: makeOpening(full),
    headings: extractHeadings(html),
    words: countWords(full),
  };
}

/** What gets embedded for an item: the title, then its opening, on one line each. */
export function embedInput(title: string, opening: string): string {
  return `${title.trim()}\n\n${opening.replace(/\s+/g, " ").trim()}`.trim();
}
