import type {
  AcademicClient,
  Alert,
  AuditClient,
  AuditEvent,
  CalendarClient,
  CalendarEvent,
  DeviceClient,
  EventExtractionClient,
  ExtractedEvent,
  FleetHealth,
  LectureClient,
  LectureStructure,
  NotificationsClient,
  ScheduledClass,
  TranscriptClient,
  TranscriptSummary,
} from './clients.js';

export interface UpstreamClients {
  academic: AcademicClient;
  calendar: CalendarClient;
  lectures: LectureClient;
  audit: AuditClient;
  transcripts: TranscriptClient;
  events: EventExtractionClient;
  devices: DeviceClient;
  notifications: NotificationsClient;
}

/** In-memory upstream data with client views over it (tests and local development). */
export class FakeUpstreams {
  scheduledClasses: ScheduledClass[] = [];
  calendarEvents: CalendarEvent[] = [];
  lectures = new Map<string, LectureStructure>();
  auditEvents: AuditEvent[] = [];
  transcripts: TranscriptSummary[] = [];
  extractedEvents: ExtractedEvent[] = [];
  fleet: FleetHealth = {
    generatedAt: new Date(0).toISOString(),
    summary: { total: 0, byStatus: {}, withIssues: 0 },
    devices: [],
  };
  alerts: Alert[] = [];
  /** Number of upstream calls (lets tests assert that snapshots avoid live collection). */
  calls = 0;

  clients(): UpstreamClients {
    const hit = <T>(v: T): Promise<T> => {
      this.calls++;
      return Promise.resolve(v);
    };
    return {
      academic: {
        listScheduledClasses: (sectionId, from, to) =>
          hit(
            this.scheduledClasses.filter(
              (c) => c.classSectionId === sectionId && c.endsAt > from && c.startsAt < to,
            ),
          ),
      },
      calendar: {
        listEvents: (inst, from, to) =>
          hit(
            this.calendarEvents.filter(
              (e) => e.institutionId === inst && e.eventDate >= from && e.eventDate <= to,
            ),
          ),
      },
      lectures: { getLecture: (id) => hit(this.lectures.get(id) ?? null) },
      audit: {
        listEvents: (tenant, action, from, to) =>
          hit(
            this.auditEvents.filter(
              (e) =>
                e.tenantId === tenant &&
                e.action === action &&
                e.occurredAt >= from &&
                e.occurredAt <= to,
            ),
          ),
      },
      transcripts: {
        listByRecording: (rec) => hit(this.transcripts.filter((t) => t.recordingSessionId === rec)),
      },
      events: {
        listForSection: (sec) => hit(this.extractedEvents.filter((e) => e.classSectionId === sec)),
      },
      devices: { fleetHealth: () => hit(this.fleet) },
      notifications: {
        listAlerts: (inst, status) =>
          hit(
            this.alerts.filter(
              (a) => a.institutionId === inst && (status === undefined || a.status === status),
            ),
          ),
      },
    };
  }
}
