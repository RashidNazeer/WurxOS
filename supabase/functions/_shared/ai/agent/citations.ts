// Grounding checks on the answer (phase5-design.md §3 rule 7, §7):
//   • citation ids the tools did not return this turn are stripped, in the
//     stream itself (a bracket is held back until it closes);
//   • emoji are stripped on serious topics (persona.md §5);
//   • numbers without a [D#] in the same sentence are flagged for the log.

// S = retrieved passage, D = data tool, W = a page from the open internet.
const CITE_GROUP = /^\[((?:[SDW]\d{1,3})(?:\s*[,;]\s*[SDW]\d{1,3})*)\]$/;
const EMOJI = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:️|‍(?:\p{Extended_Pictographic}))*️?/gu;

// One [..] group → the same group with only the known ids, or '' if none is known.
export function filterGroup(group: string, known: (id: string) => boolean, stripped: string[]): string {
  const m = group.match(CITE_GROUP);
  if (!m) return group;                                  // not a citation: leave it
  const ids = m[1].split(/[,;]/).map((s) => s.trim());
  const ok = ids.filter((id) => known(id));
  stripped.push(...ids.filter((id) => !known(id)));
  return ok.length ? `[${ok.join(', ')}]` : '';
}

// Whole-text version (tests, non-streamed paths).
export function stripUnknownCitations(text: string, known: (id: string) => boolean): { text: string; stripped: string[] } {
  const stripped: string[] = [];
  const out = String(text).replace(/\[[^\[\]\n]{1,40}\]/g, (g) => filterGroup(g, known, stripped));
  return { text: out, stripped };
}

// Streaming version: push() returns what is safe to send now.
export class CitationStream {
  private held = '';
  readonly stripped: string[] = [];
  private known: (id: string) => boolean;
  private noEmoji: () => boolean;
  constructor(known: (id: string) => boolean, noEmoji: () => boolean = () => false) {
    this.known = known;
    this.noEmoji = noEmoji;
  }

  push(delta: string): string {
    let out = '';
    for (const ch of delta) {
      if (this.held) {
        this.held += ch;
        if (ch === ']') { out += filterGroup(this.held, this.known, this.stripped); this.held = ''; }
        else if (this.held.length > 40 || ch === '\n' || ch === '[') {
          // Not a citation after all; a '[' starts a new candidate.
          const again = ch === '[';
          out += again ? this.held.slice(0, -1) : this.held;
          this.held = again ? '[' : '';
        }
      } else if (ch === '[') {
        this.held = '[';
      } else {
        out += ch;
      }
    }
    return this.clean(out);
  }

  flush(): string {
    const rest = this.held;
    this.held = '';
    return this.clean(rest);
  }

  private clean(s: string): string {
    return this.noEmoji() ? s.replace(EMOJI, '').replace(/ {2,}/g, ' ') : s;
  }
}

export const stripEmoji = (s: string) => s.replace(EMOJI, '');

export function citedIds(text: string): string[] {
  const ids = new Set<string>();
  for (const m of String(text).matchAll(/\[((?:[SDW]\d{1,3})(?:\s*[,;]\s*[SDW]\d{1,3})*)\]/g)) {
    for (const id of m[1].split(/[,;]/)) ids.add(id.trim());
  }
  return [...ids];
}

// A figure that looks like data: money, a percentage, a ratio like 3.62x, or
// a number of 4+ digits. Dates, week numbers, list markers, SOP step numbers
// and small counts are not flagged.
const FIGURE = /(?:[$£€]\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?%|\b\d+(?:\.\d+)?x\b|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d{4,}(?:\.\d+)?\b)/i;
const DATE_LIKE = /\b(?:19|20)\d{2}\b(?!\s?%)|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\bweeks?\s+\d+/gi;

// Sentences (or bullet lines) that state a figure but carry no [D#] or [W#].
// A [W#] counts as grounded: a figure quoted from a web page the model actually
// read is attributed, even though it did not come out of our own database.
export function numbersWithoutData(text: string): string[] {
  const out: string[] = [];
  for (const line of String(text).split(/\n+/)) {
    for (const sentence of line.split(/(?<=[.!?])\s+(?=[A-Z*"(])/)) {
      const probe = sentence.replace(DATE_LIKE, ' ').replace(/https?:\/\/\S+/g, ' ');
      if (!FIGURE.test(probe)) continue;
      if (/\[(?:[SDW]\d+\s*[,;]\s*)*[DW]\d+/.test(sentence)) continue;
      out.push(sentence.trim().slice(0, 200));
    }
  }
  return out;
}
