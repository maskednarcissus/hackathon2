'use client';

import { useEffect } from 'react';

/**
 * Deep link support: `?t=<ms>` (or `?s=<segmentIndex>`) scrolls to and focuses the segment containing that instant.
 * Segments are rendered by the server with `data-start`/`data-end` attributes.
 */
export function TranscriptFocus({
  targetMs,
  targetIndex,
}: {
  targetMs: number | null;
  targetIndex: number | null;
}): null {
  useEffect(() => {
    if (targetMs === null && targetIndex === null) return;
    const items = Array.from(document.querySelectorAll<HTMLElement>('[data-start]'));
    const byIndex = targetIndex !== null ? document.getElementById(`s-${targetIndex}`) : null;
    const ms = targetMs ?? -1;
    const match =
      byIndex ??
      items.find((el) => Number(el.dataset['start']) <= ms && ms < Number(el.dataset['end'])) ??
      items.find((el) => Number(el.dataset['start']) >= ms) ??
      items[items.length - 1];
    if (match === undefined) return;
    match.dataset['active'] = 'true';
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    match.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    match.focus({ preventScroll: true });
  }, [targetMs, targetIndex]);
  return null;
}
