/**
 * Blackboard Learn connector (REST `/learn/api/public`, OAuth2 client credentials; the token
 * endpoint defaults to `/learn/api/public/v1/oauth2/token`).
 *
 * Inbound: courses (`/v3/courses`, mapped by course `externalId` or `mappings.sections[<id>|<courseId>]`)
 * and memberships (`/v1/courses/{id}/users?expand=user`, role `Student`; availability
 * `Yes` → active, otherwise withdrawn) → students (`user.externalId` or `studentId`) and enrollments.
 * Paging follows `paging.nextPage`.
 *
 * Outbound: course announcements (`POST /v1/courses/{id}/announcements`) and calendar items
 * (`POST /v1/calendars/items`, type `Course`).
 */
import { CanonicalBuilder } from './canonical.js';
import { ConnectorError, arr, obj, str, type ConnectorHttp, type Json } from './http.js';
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

const API = '/learn/api/public';

export class BlackboardConnector implements LmsConnector {
  readonly type = 'blackboard' as const;

  constructor(
    private readonly config: ConnectorConfig,
    private readonly http: ConnectorHttp,
  ) {}

  async list(path: string, query: Record<string, string> = {}): Promise<Json[]> {
    const out: Json[] = [];
    let next: string | null = path;
    let first = true;
    for (let pages = 0; next; pages++) {
      if (pages > 100_000) throw new ConnectorError('paging_runaway', `${path}: too many pages`);
      const res = await this.http.get(next, first ? { query: { limit: String(this.config.mappings.pageSize), ...query } } : {});
      this.http.stats.pages++;
      const body = obj(res.body);
      out.push(...arr(body['results']).map(obj));
      const nextPage = str(obj(body['paging'])['nextPage']);
      next = nextPage ? (nextPage.startsWith('/learn/') ? nextPage : `${API}${nextPage.startsWith('/') ? '' : '/'}${nextPage}`) : null;
      first = false;
    }
    return out;
  }

  async pull(_ctx: PullContext): Promise<PullResult> {
    const m = this.config.mappings;
    const b = new CanonicalBuilder();
    const courses = await this.list(`${API}/v3/courses`, { fields: 'id,courseId,externalId,name' });
    let unmapped = 0;
    const mapped = courses
      .map((c) => ({ course: c, section: sectionFor(this.config, [str(c['id']), str(c['courseId'])], str(c['externalId'])) }))
      .filter((x): x is { course: Json; section: string } => {
        if (!x.section) unmapped++;
        return x.section !== undefined;
      });

    await mapLimit(mapped, m.concurrency, async ({ course, section }, i) => {
      const id = str(course['id']) ?? '';
      const path = `courses[${i}]`;
      try {
        const members = await this.list(`${API}/v1/courses/${encodeURIComponent(id)}/users`, { expand: 'user' });
        for (const [j, mbr] of members.entries()) {
          if (str(mbr['courseRoleId']) !== 'Student') continue;
          const user = obj(mbr['user']);
          const name = obj(user['name']);
          const ext = b.addStudent(`${path}.memberships[${j}]`, {
            externalId: str(user['externalId']) ?? str(user['studentId']),
            name: [str(name['given']), str(name['family'])].filter(Boolean).join(' ') || undefined,
            email: str(obj(user['contact'])['email'])?.toLowerCase(),
          });
          const available = str(obj(mbr['availability'])['available']);
          if (ext) b.addEnrollment(ext, section, available === 'Yes' ? 'active' : 'withdrawn');
        }
      } catch (err) {
        if (!(err instanceof ConnectorError) || err.code === 'auth_failed') throw err;
        b.failed(path, `course ${id}: ${err.message}`);
      }
    });
    if (unmapped > 0)
      b.warn('courses', 'connector.unmapped_courses', `${unmapped} Blackboard courses are not mapped to a class section`);

    return {
      payload: b.build({ timezone: m.timezone }),
      warnings: b.warnings,
      partial: b.partial,
      stats: { ...this.http.stats, incremental: false, coursesMapped: mapped.length, coursesUnmapped: unmapped },
    };
  }

  async publishAnnouncement(target: OutboundTarget, item: Announcement): Promise<{ externalId: string }> {
    const res = await this.http.post(`${API}/v1/courses/${encodeURIComponent(target.lmsCourseId)}/announcements`, {
      json: { title: item.title, body: item.message, availability: { duration: { type: 'Permanent' } } },
    });
    const id = str(obj(res.body)['id']);
    if (!id) throw new ConnectorError('invalid_upstream_data', 'announcement created without id');
    return { externalId: id };
  }

  async publishCalendarItem(target: OutboundTarget, item: CalendarItem): Promise<{ externalId: string }> {
    const res = await this.http.post(`${API}/v1/calendars/items`, {
      json: {
        type: 'Course',
        calendarId: target.lmsCourseId,
        title: item.title,
        description: item.description,
        start: item.start.toISOString(),
        end: item.end.toISOString(),
      },
    });
    const id = str(obj(res.body)['id']);
    if (!id) throw new ConnectorError('invalid_upstream_data', 'calendar item created without id');
    return { externalId: id };
  }
}
