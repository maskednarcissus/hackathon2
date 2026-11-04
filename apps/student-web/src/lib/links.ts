/** Deep links into the transcript viewer. */
export function transcriptAtMs(
  scheduledClassId: string,
  ms: number,
  segmentIndex?: number,
): string {
  const base = `/aulas/${encodeURIComponent(scheduledClassId)}/transcricao?t=${Math.max(0, Math.floor(ms))}`;
  return segmentIndex !== undefined ? `${base}#s-${segmentIndex}` : base;
}

export function transcriptAtSegment(scheduledClassId: string, segmentIndex: number): string {
  return `/aulas/${encodeURIComponent(scheduledClassId)}/transcricao?s=${segmentIndex}#s-${segmentIndex}`;
}
