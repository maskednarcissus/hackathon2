import { highlightParts } from '@/lib/highlight';

/** Renders `text` with query terms wrapped in <mark> (no HTML injection possible). */
export function Highlighted({ text, query }: { text: string; query: string }): React.JSX.Element {
  return (
    <>
      {highlightParts(text, query).map((part, i) =>
        part.match ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>,
      )}
    </>
  );
}
