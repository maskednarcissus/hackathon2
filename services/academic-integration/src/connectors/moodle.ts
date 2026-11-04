/**
 * Moodle connector (Web services REST protocol, `api_key` = web service token).
 *
 * Inbound: `core_course_get_courses` → courses mapped to class sections (`idnumber` or
 * `mappings.sections[<id>|<shortname>]`); `core_enrol_get_enrolled_users` (paged with
 * `limitfrom`/`limitnumber`, active enrolments only) → students (`idnumber` = SIS id) and enrollments.
 * Moodle reports errors as HTTP 200 with `{ exception, errorcode, message }`.
 *
 * Outbound: announcements via `mod_forum_add_discussion` (the course news forum, `forumId`),
 * calendar items via `core_calendar_create_calendar_events` (course events).
 */
import { CanonicalBuilder } from './canonical.js';
import { ConnectorError, arr, num, obj, str, type ConnectorHttp, type Json } from './http.js';
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

const ENDPOINT = '/webservice/rest/server.php';

export class MoodleConnector implements LmsConnector {
  readonly type = 'moodle' as const;

  constructor(
    private readonly config: ConnectorConfig,
    private readonly http: ConnectorHttp,
  ) {}

  async call(fn: string, params: Record<string, string> = {}, write = false): Promise<unknown> {
    const path = this.config.mappings.paths['rest'] ?? ENDPOINT;
    const common = { wsfunction: fn, moodlewsrestformat: 'json' };
    const res = write
      ? await this.http.post(path, { query: common, form: params })
      : await this.http.get(path, { query: { ...common, ...params } });
    const body = obj(res.body);
    if (typeof body['exception'] === 'string') {
      const code = str(body['errorcode']) ?? 'moodle_error';
      throw new ConnectorError(
        code === 'invalidtoken' ? 'auth_failed' : `moodle_${code}`,
        `${fn}: ${str(body['message']) ?? code}`,
      );
    }
    return res.body;
  }

  async pull(_ctx: PullContext): Promise<PullResult> {
    const b = new CanonicalBuilder();
    const m = this.config.mappings;
    const courses = arr(await this.call('core_course_get_courses'))
      .map(obj)
      .filter((c) => str(c['format']) !== 'site');
    let unmapped = 0;
    const mapped = courses
      .map((c) => ({
        course: c,
        section: sectionFor(this.config, [str(c['id']), str(c['shortname'])], str(c['idnumber'])),
      }))
      .filter((x): x is { course: Json; section: string } => {
        if (!x.section) unmapped++;
        return x.section !== undefined;
      });

    await mapLimit(mapped, m.concurrency, async ({ course, section }, i) => {
      const courseId = str(course['id']) ?? '';
      const path = `courses[${i}]`;
      try {
        for (let from = 0; from < 1_000_000; from += m.pageSize) {
          const users = arr(
            await this.call('core_enrol_get_enrolled_users', {
              courseid: courseId,
              'options[0][name]': 'onlyactive',
              'options[0][value]': '1',
              'options[1][name]': 'limitfrom',
              'options[1][value]': String(from),
              'options[2][name]': 'limitnumber',
              'options[2][value]': String(m.pageSize),
            }),
          ).map(obj);
          this.http.stats.pages++;
          for (const [j, u] of users.entries()) {
            const roles = arr(u['roles']).map((r) => str(obj(r)['shortname']));
            if (!roles.includes('student')) continue;
            const ext = b.addStudent(`${path}.users[${from + j}]`, {
              externalId: str(u['idnumber']),
              name: str(u['fullname']),
              email: str(u['email'])?.toLowerCase(),
            });
            if (ext) b.addEnrollment(ext, section, 'active');
          }
          if (users.length < m.pageSize) break;
        }
      } catch (err) {
        if (!(err instanceof ConnectorError) || err.code === 'auth_failed') throw err;
        b.failed(path, `course ${courseId}: ${err.message}`);
      }
    });
    if (unmapped > 0)
      b.warn('courses', 'connector.unmapped_courses', `${unmapped} Moodle courses are not mapped to a class section`);

    return {
      payload: b.build({ timezone: m.timezone }),
      warnings: b.warnings,
      partial: b.partial,
      stats: { ...this.http.stats, incremental: false, coursesMapped: mapped.length, coursesUnmapped: unmapped },
    };
  }

  async publishAnnouncement(target: OutboundTarget, item: Announcement): Promise<{ externalId: string }> {
    if (!target.forumId)
      throw new ConnectorError('invalid_config', `course ${target.lmsCourseId}: outbound forumId is required for Moodle announcements`);
    const body = obj(
      await this.call(
        'mod_forum_add_discussion',
        { forumid: target.forumId, subject: item.title, message: item.message },
        true,
      ),
    );
    const id = str(body['discussionid']);
    if (!id) throw new ConnectorError('invalid_upstream_data', 'mod_forum_add_discussion returned no discussionid');
    return { externalId: id };
  }

  async publishCalendarItem(target: OutboundTarget, item: CalendarItem): Promise<{ externalId: string }> {
    const start = Math.floor(item.start.getTime() / 1000);
    const body = obj(
      await this.call(
        'core_calendar_create_calendar_events',
        {
          'events[0][name]': item.title,
          'events[0][description]': item.description,
          'events[0][format]': '1',
          'events[0][courseid]': target.lmsCourseId,
          'events[0][timestart]': String(start),
          'events[0][timeduration]': String(Math.floor(item.end.getTime() / 1000) - start),
          'events[0][eventtype]': 'course',
        },
        true,
      ),
    );
    const id = num(obj(arr(body['events'])[0])['id']);
    if (id === undefined) {
      const warning = str(obj(arr(body['warnings'])[0])['message']);
      throw new ConnectorError('moodle_calendar_rejected', warning ?? 'no event created');
    }
    return { externalId: String(id) };
  }
}
