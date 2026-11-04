/**
 * Brazilian Portuguese text normalisation (accent folding, stopwords, light stemming).
 * Vendored from services/transcript-management/src/search/text.ts — keep in sync.
 */

// Common pt-BR function words (accent-folded). Kept small on purpose: content words must survive.
const STOPWORDS = new Set(
  (
    'a o as os um uma uns umas de do da dos das no na nos nas em num numa ao aos à às pelo pela pelos pelas ' +
    'por para pra pro com sem sob sobre entre ate desde e ou mas nem que se como quando onde quem qual quais ' +
    'cujo cuja este esta estes estas esse essa esses essas aquele aquela aqueles aquelas isto isso aquilo ' +
    'eu tu ele ela nos vos eles elas me te lhe lhes meu minha meus minhas seu sua seus suas nosso nossa ' +
    'nossos nossas teu tua teus tuas dele dela deles delas voce voces ja nao sim mais menos muito muita muitos muitas tambem so entao la aqui ai ' +
    'ser e era foi sao estar esta estao ter tem tinha ha vai vamos vou fazer faz ' +
    'the of and to in is it on for'
  )
    .split(/\s+/)
    .map((w) => fold(w)),
);

export function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Ordered suffix rules [suffix, replacement, minimum stem length]; first match wins. */
const SUFFIX_RULES: readonly (readonly [string, string, number])[] = [
  ['amentos', '', 3],
  ['imentos', '', 3],
  ['amento', '', 3],
  ['imento', '', 3],
  ['mente', '', 4],
  ['idades', '', 3],
  ['idade', '', 3],
  ['coes', 'c', 2],
  ['cao', 'c', 2],
  ['soes', 's', 2],
  ['sao', 's', 2],
  ['oes', 'ao', 2],
  ['aes', 'ao', 2],
  ['ais', 'al', 2],
  ['eis', 'el', 2],
  ['ois', 'ol', 2],
  ['ns', 'm', 2],
  ['res', 'r', 3],
  ['ezas', 'ez', 2],
  ['eza', 'ez', 2],
  ['istas', 'ist', 3],
  ['ista', 'ist', 3],
  ['inhos', '', 3],
  ['inhas', '', 3],
  ['inho', '', 3],
  ['inha', '', 3],
  ['as', '', 3],
  ['os', '', 3],
  ['es', '', 4],
  ['s', '', 3],
  ['a', '', 3],
  ['o', '', 3],
  ['e', '', 3],
];

/** Light stemmer: removes plural, gender and frequent derivational suffixes. */
export function stem(token: string): string {
  if (token.length <= 3 || /^\d+$/.test(token)) return token;
  for (const [suffix, replacement, minStem] of SUFFIX_RULES) {
    if (token.endsWith(suffix) && token.length - suffix.length >= minStem) {
      return token.slice(0, token.length - suffix.length) + replacement;
    }
  }
  return token;
}

/** Raw word tokens (accent-folded, lowercase) with their character offsets in the original text. */
export function wordSpans(text: string): { token: string; start: number; end: number }[] {
  const spans: { token: string; start: number; end: number }[] = [];
  // Letters (incl. accented) and digits; folding happens per token so offsets stay aligned.
  const re = /[\p{L}\p{N}]+/gu;
  for (const m of text.matchAll(re)) {
    spans.push({ token: fold(m[0]), start: m.index, end: m.index + m[0].length });
  }
  return spans;
}

/** Index terms of a text: folded, stopwords removed, stemmed. */
export function analyze(text: string): string[] {
  const terms: string[] = [];
  for (const { token } of wordSpans(text)) {
    if (STOPWORDS.has(token)) continue;
    terms.push(stem(token));
  }
  return terms;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

/**
 * HTML-escaped text with every word whose stem is in `terms` wrapped in `<mark>`.
 * Long texts are windowed around the first match (`maxLength` characters, with ellipses).
 */
export function highlight(text: string, terms: ReadonlySet<string>, maxLength = 280): string {
  const spans = wordSpans(text).filter((s) => !STOPWORDS.has(s.token) && terms.has(stem(s.token)));
  let from = 0;
  let to = text.length;
  if (text.length > maxLength) {
    const first = spans[0]?.start ?? 0;
    from = Math.max(0, first - Math.floor(maxLength / 3));
    to = Math.min(text.length, from + maxLength);
    // snap to word boundaries
    while (from > 0 && /[\p{L}\p{N}]/u.test(text[from - 1] ?? '')) from--;
    while (to < text.length && /[\p{L}\p{N}]/u.test(text[to] ?? '')) to++;
  }
  let out = from > 0 ? '…' : '';
  let cursor = from;
  for (const s of spans) {
    if (s.start < from || s.end > to) continue;
    out +=
      escapeHtml(text.slice(cursor, s.start)) +
      '<mark>' +
      escapeHtml(text.slice(s.start, s.end)) +
      '</mark>';
    cursor = s.end;
  }
  out += escapeHtml(text.slice(cursor, to)) + (to < text.length ? '…' : '');
  return out;
}
