/** Student-web routes (apps/student-web): `/calendario/{calendarEventId}`, `/aulas/{scheduledClassId}`. */
export function studentWebPath(id: string, kind: 'calendar_event' | 'scheduled_class'): string {
  return kind === 'calendar_event'
    ? `/calendario/${encodeURIComponent(id)}`
    : `/aulas/${encodeURIComponent(id)}`;
}

/** In-app deep link (relative path) for a stored notification. */
export function notificationLink(n: {
  resourceType: string;
  resourceId: string;
  data: Record<string, unknown>;
}): string | undefined {
  const calendarEventId =
    typeof n.data.calendarEventId === 'string'
      ? n.data.calendarEventId
      : n.resourceType === 'calendar_event'
        ? n.resourceId
        : null;
  if (calendarEventId) return studentWebPath(calendarEventId, 'calendar_event');
  if (typeof n.data.scheduledClassId === 'string') {
    return studentWebPath(n.data.scheduledClassId, 'scheduled_class');
  }
  return undefined;
}
