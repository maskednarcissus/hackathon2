/**
 * Language-aware text normalisation for lexical search (Phase 6.4): accent folding, lowercase,
 * per-language stopwords and a light (plural / gender / derivational) stemmer.
 * Supported: pt (default, pt-BR), en, es, fr; any other language gets folding only.
 */

export type Lang = 'pt' | 'en' | 'es' | 'fr' | 'xx';

/** Maps a BCP-47 tag (`pt-BR`, `en-US`, `es-419`, `fr-FR`, …) to the analyser language. */
export function languageOf(tag: string | null | undefined): Lang {
  const base = (tag ?? 'pt').toLowerCase().split(/[-_]/)[0];
  return base === 'pt' || base === 'en' || base === 'es' || base === 'fr' ? base : 'xx';
}

export function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const words = (s: string): Set<string> => new Set(s.split(/\s+/).filter(Boolean).map(fold));

// Common function words (accent-folded). Kept small on purpose: content words must survive.
const STOPWORDS: Record<Lang, Set<string>> = {
  pt: words(
    'a o as os um uma uns umas de do da dos das no na nos nas em num numa ao aos à às pelo pela pelos pelas ' +
      'por para pra pro com sem sob sobre entre ate desde e ou mas nem que se como quando onde quem qual quais ' +
      'cujo cuja este esta estes estas esse essa esses essas aquele aquela aqueles aquelas isto isso aquilo ' +
      'eu tu ele ela nos vos eles elas me te lhe lhes meu minha meus minhas seu sua seus suas nosso nossa ' +
      'nossos nossas teu tua teus tuas dele dela deles delas voce voces ja nao sim mais menos muito muita muitos muitas tambem so entao la aqui ai ' +
      'ser e era foi sao estar esta estao ter tem tinha ha vai vamos vou fazer faz ' +
      'the of and to in is it on for',
  ),
  en: words(
    'a an the and or but nor of to in on at by for from with without about into over under between ' +
      'is are was were be been being am do does did have has had will would shall should can could may might must ' +
      'i you he she it we they me him her us them my your his its our their this that these those there here ' +
      'what which who whom whose when where why how not no yes so than then too very just also only all any some ' +
      'as if because while until up down out off again further once',
  ),
  es: words(
    'el la los las un una unos unas de del al a en y o u e ni que se como cuando donde quien cual cuales ' +
      'por para con sin sobre entre hasta desde mas pero muy tambien ya no si este esta estos estas ese esa esos esas ' +
      'aquel aquella aquellos aquellas esto eso aquello yo tu el ella nosotros vosotros ellos ellas me te le les lo ' +
      'mi mis su sus nuestro nuestra nuestros nuestras es son era fue ser estar esta estan tener tiene hay va vamos hacer hace',
  ),
  fr: words(
    'le la les l un une des de du d au aux a à et ou ni mais que qu qui quoi dont ou se ce cet cette ces ' +
      'par pour avec sans sur sous entre dans en vers chez plus moins tres aussi deja ne pas non oui si ' +
      'je tu il elle nous vous ils elles me te lui leur leurs mon ma mes ton ta tes son sa ses notre nos votre vos ' +
      'est sont etait ete etre avoir a ont avait fait faire va aller y',
  ),
  xx: new Set(),
};

type Rule = readonly [suffix: string, replacement: string, minStem: number];

/** Ordered suffix rules per language; first match wins. */
const RULES: Record<Exclude<Lang, 'xx'>, readonly Rule[]> = {
  pt: [
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
  ],
  en: [
    ['ational', 'ate', 3],
    ['ations', 'ate', 3],
    ['ation', 'ate', 3],
    ['nesses', '', 3],
    ['ness', '', 3],
    ['ments', '', 4],
    ['ment', '', 4],
    ['ities', '', 3],
    ['ity', '', 3],
    ['ingly', '', 3],
    ['edly', '', 3],
    ['ing', '', 3],
    ['ies', 'y', 2],
    ['ied', 'y', 2],
    ['ed', '', 3],
    ['ly', '', 3],
    ['es', '', 4],
    ['s', '', 3],
    ['e', '', 3],
  ],
  es: [
    ['amientos', '', 3],
    ['imientos', '', 3],
    ['amiento', '', 3],
    ['imiento', '', 3],
    ['mente', '', 4],
    ['idades', '', 3],
    ['idad', '', 3],
    ['ciones', 'c', 2],
    ['cion', 'c', 2],
    ['siones', 's', 2],
    ['sion', 's', 2],
    ['istas', 'ist', 3],
    ['ista', 'ist', 3],
    ['ales', 'al', 2],
    ['eses', 'es', 2],
    ['res', 'r', 3],
    ['ces', 'z', 2],
    ['as', '', 3],
    ['os', '', 3],
    ['es', '', 4],
    ['s', '', 3],
    ['a', '', 3],
    ['o', '', 3],
    ['e', '', 3],
  ],
  fr: [
    ['issements', '', 3],
    ['issement', '', 3],
    ['ements', '', 3],
    ['ement', '', 3],
    ['ations', 'at', 3],
    ['ation', 'at', 3],
    ['ites', '', 3],
    ['ite', '', 3],
    ['euses', 'eu', 3],
    ['euse', 'eu', 3],
    ['eaux', 'eau', 2],
    ['aux', 'al', 2],
    ['eux', 'eu', 3],
    ['istes', 'ist', 3],
    ['iste', 'ist', 3],
    ['ives', 'if', 3],
    ['ive', 'if', 3],
    ['es', '', 4],
    ['s', '', 3],
    ['x', '', 3],
    ['e', '', 3],
  ],
};

/** Light stemmer: removes plural, gender and frequent derivational suffixes. */
export function stem(token: string, lang: Lang = 'pt'): string {
  if (lang === 'xx' || token.length <= 3 || /^\d+$/.test(token)) return token;
  for (const [suffix, replacement, minStem] of RULES[lang]) {
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

export const isStopword = (token: string, lang: Lang = 'pt'): boolean => STOPWORDS[lang].has(token);

/** Index terms of a text: folded, stopwords removed, stemmed — for the given language. */
export function analyze(text: string, lang: Lang = 'pt'): string[] {
  const terms: string[] = [];
  for (const { token } of wordSpans(text)) {
    if (isStopword(token, lang)) continue;
    terms.push(stem(token, lang));
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
export function highlight(
  text: string,
  terms: ReadonlySet<string>,
  maxLength = 280,
  lang: Lang = 'pt',
): string {
  const spans = wordSpans(text).filter(
    (s) => !isStopword(s.token, lang) && terms.has(stem(s.token, lang)),
  );
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
