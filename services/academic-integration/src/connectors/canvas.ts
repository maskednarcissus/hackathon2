/**
 * Canvas LMS connector (REST `/api/v1`, bearer token via `api_key` or OAuth2).
 *
 * Inbound: courses (`/api/v1/accounts/{accountId}/courses` or `/api/v1/courses`), their sections
 * (`/sections`, mapped by `sis_section_id` or `mappings.sections[<section id>]`) and student
 * enrollments (`/enrollments?type[]=StudentEnrollment`, all states) → students (`sis_user_id`) and
 * enrollments (`active`, `completed`, `inactive|deleted` → withdrawn). Paging follows the `Link`
 * header (`rel="next"`), which must stay on the configured host.
 *
 * Outbound: announcements (`POST /courses/{id}/discussion_topics`, `is_announcement`) and calendar
 * events (`POST /api/v1/calendar_events`, `context_code: course_<id>`).
 */
import { CanonicalBuilder } from './canonical.js';
import { ConnectorError, arr, nextLink, obj, str, type ConnectorHttp, type Json } from './http.js';
import { sectionFor } from './lms.js';
import {
  mapLimit,
  type Announcement,
  type CalendarItem,
  type ConnectorConfig,
  type LmsConnector,
  type OutboundTarget,
  type PullContext,
  type PullResult,
} from './types.js';

const STATUS: Record<string, 'active' | 'completed' | 'withdrawn'> = {
  active: 'active',
  completed: 'completed',
  inactive: 'withdrawn',
  deleted: 'withdrawn',
};

export class CanvasConnector implements LmsConnector {
  readonly type = 'canvas' as const;

  constructor(
    private readonly config: ConnectorConfig,
    private readonly http: ConnectorHttp,
  ) {}

  async list(path: string, query: Record<string, string | readonly string[]> = {}): Promise<Json[]> {
    const out: Json[] = [];
    let next: string | null = path;
    let first = true;
    while (next) {
      const res = await this.http.get(next, first ? { query: { per_page: String(this.config.mappings.pageSize), ...query } } : {});
      this.http.stats.pages++;
      out.push(...arr(res.body).map(obj));
      next = nextLink(res.headers.get('link'));
      first = false;
      if (this.http.stats.pages > 100_000) throw new ConnectorError('paging_runaway', `${path}: too many pages`);
    }
    return out;
  }

  async pull(_ctx: PullContext): Promise<PullResult> {
    const m = this.config.mappings;
    const b = new CanonicalBuilder();
    const courses = await this.list(m.accountId ? `/api/v1/accounts/${encodeURIComponent(m.accountId)}/courses` : '/api/v1/courses');
    let mappedSections = 0;
    let unmappedSections = 0;

    await mapLimit(courses, m.concurrency, async (course, i) => {
      const courseId = str(course['id']);
      if (!courseId) return;
      const path = `courses[${i}]`;
      try {
        const sections = await this.list(`/api/v1/courses/${courseId}/sections`);
        const bySection = new Map<string, string>();
        for (const s of sections) {
          const id = str(s['id']);
          const target = sectionFor(this.config, [id], str(s['sis_section_id']));
          if (id && target) bySection.set(id, target);
          else unmappedSections++;
        }
        if (bySection.size === 0) return;
        mappedSections += bySection.size;
        const enrollments = await this.list(`/api/v1/courses/${courseId}/enrollments`, {
          'type[]': ['StudentEnrollment'],
          'state[]': ['active', 'completed', 'inactive', 'deleted'],
        });
        for (const [j, e] of enrollments.entries()) {
          const section = bySection.get(str(e['course_section_id']) ?? '');
          const status = STATUS[str(e['enrollment_state']) ?? ''];
          if (!section || !status) continue;
          const user = obj(e['user']);
          const email = str(user['email']) ?? str(user['login_id']);
          const ext = b.addStudent(`${path}.enrollments[${j}]`, {
            externalId: str(user['sis_user_id']),
            name: str(user['name']),
            email: email?.toLowerCase(),
          });
          if (ext) b.addEnrollment(ext, section, status);
        }
      } catch (err) {
        if (!(err instanceof ConnectorError) || err.code === 'http_401') throw err;
        b.failed(path, `course ${courseId}: ${err.message}`);
      }
    });
    if (unmappedSections > 0)
      b.warn('sections', 'connector.unmapped_sections', `${unmappedSections} Canvas sections are not mapped to a class section`);

    return {
      payload: b.build({ timezone: m.timezone }),
      warnings: b.warnings,
      partial: b.partial,
      stats: { ...this.http.stats, incremental: false, sectionsMapped: mappedSections, sectionsUnmapped: unmappedSections },
    };
  }

  async publishAnnouncement(target: OutboundTarget, item: Announcement): Promise<{ externalId: string }> {
    const res = await this.http.post(`/api/v1/courses/${encodeURIComponent(target.lmsCourseId)}/discussion_topics`, {
      json: { title: item.title, message: item.message, is_announcement: true, published: true },
    });
    const id = str(obj(res.body)['id']);
    if (!id) throw new ConnectorError('invalid_upstream_data', 'announcement created without id');
    return { externalId: id };
  }

  async publishCalendarItem(target: OutboundTarget, item: CalendarItem): Promise<{ externalId: string }> {
    const res = await this.http.post('/api/v1/calendar_events', {
      json: {
        calendar_event: {
          context_code: `course_${target.lmsCourseId}`,
          title: item.title,
          description: item.description,
          start_at: item.start.toISOString(),
          end_at: item.end.toISOString(),
          all_day: item.allDay,
        },
      },
    });
    const id = str(obj(res.body)['id']);
    if (!id) throw new ConnectorError('invalid_upstream_data', 'calendar event created without id');
    return { externalId: id };
  }
}
