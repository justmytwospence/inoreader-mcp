import { makeOpening, OPENING_CHARS } from "./text.js";

// Generic text statistics for filters. They describe the text, not its worth: a
// "prose paragraph" is just a paragraph of at least PROSE_MIN_WORDS words that ends
// in sentence punctuation. Lists, code, navigation, badges and one-line taglines
// are not. Every item is measured over its opening (the first ~1,200 characters,
// cut at a sentence end), because that is all the index keeps for items outside
// the narrower tiers; measuring stored full text instead would judge two items of
// the same kind differently.

export const PROSE_MIN_WORDS = 25;
const SENTENCE_END = /[.?!:]["'\u201d\u2019)\]]?$/;

export interface ProseStats {
  /** Paragraphs of PROSE_MIN_WORDS+ words ending in sentence punctuation, within the opening. */
  prose_paragraphs: number;
  /** Share of the opening's words that are in prose paragraphs, 0-1. */
  prose_ratio: number;
}

const wordCount = (s: string) => s.match(/\S+/g)?.length ?? 0;

/** Stats over the opening of `text` (paragraphs separated by blank lines, as cleanHtml writes them). */
export function proseStats(text: string): ProseStats {
  const sample = text.length > OPENING_CHARS ? makeOpening(text) : text;
  let total = 0;
  let proseWords = 0;
  let paragraphs = 0;
  for (const raw of sample.split(/\n\s*\n/)) {
    const p = raw.trim();
    if (!p) continue;
    const n = wordCount(p);
    total += n;
    if (n >= PROSE_MIN_WORDS && SENTENCE_END.test(p)) {
      paragraphs++;
      proseWords += n;
    }
  }
  return { prose_paragraphs: paragraphs, prose_ratio: total ? Math.round((proseWords / total) * 100) / 100 : 0 };
}

/** A URL's host, lowercased, without `www.`; "" when it cannot be parsed. */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  } catch {
    return "";
  }
}

/** A domain as given in a config or a filter, normalized; undefined when it is not a host name. */
export function normalizeDomain(raw: string): string | undefined {
  const d = raw.trim().toLowerCase().replace(/^\*\./, "").replace(/^www\./, "").replace(/\.$/, "");
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(d) ? d : undefined;
}

/** True when `host` is one of `domains` or a subdomain of one (`github.com` covers `gist.github.com`). */
export function domainMatches(host: string, domains: readonly string[]): boolean {
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}
