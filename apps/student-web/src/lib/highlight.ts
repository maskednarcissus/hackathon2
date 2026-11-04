/**
 * Splits `text` into plain/match parts for the query terms, accent- and case-insensitive.
 * Rendering is done with React elements (never innerHTML), so upstream highlight markup can't
 * inject HTML.
 */
export interface TextPart {
  text: string;
  match: boolean;
}

const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function queryTerms(query: string): string[] {
  return Array.from(
    new Set(
      fold(query)
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length >= 2),
    ),
  );
}

export function highlightParts(text: string, query: string): TextPart[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [{ text, match: false }];
  // Folding NFD then stripping marks keeps a 1:1 index map for pt-BR precomposed characters
  // only after re-composition, so build the folded string character by character.
  const chars = Array.from(text);
  const folded = chars.map((c) => fold(c));
  const foldedText = folded.join('');
  const starts: number[] = [];
  let acc = 0;
  for (const f of folded) {
    starts.push(acc);
    acc += f.length;
  }
  const marks = new Array<boolean>(chars.length).fill(false);
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const idx = foldedText.indexOf(term, from);
      if (idx === -1) break;
      const end = idx + term.length;
      starts.forEach((s, i) => {
        if (s >= idx && s < end) marks[i] = true;
      });
      from = end;
    }
  }
  const parts: TextPart[] = [];
  chars.forEach((c, i) => {
    const match = marks[i] ?? false;
    const last = parts[parts.length - 1];
    if (last !== undefined && last.match === match) last.text += c;
    else parts.push({ text: c, match });
  });
  return parts;
}
