/**
 * Ellucian Banner and Colleague through the Ethos Integration API.
 *
 * Auth: `POST {base}/auth` with the API key → short-lived JWT (see `EthosAuth`). Resources are read
 * from `{base}/api/<resource>` with versioned media types and `offset`/`limit` paging (total in
 * `x-total-count`). Mapping:
 *
 * | Ethos                       | canonical                                              |
 * |-----------------------------|--------------------------------------------------------|
 * | academic-periods/{id}       | term (externalId = period `code`)                      |
 * | sections (by period)        | class section (externalId = section `code`, e.g. CRN)  |
 * | courses/{id} + subjects/{id}| course (`<subject abbreviation><number>`)              |
 * | instructional-events        | weekly slots (`recurrence.repeatRule.daysOfWeek`, times in the campus timezone, room) |
 * | section-instructors         | professor (primary instructor)                         |
 * | section-registrations       | enrollment (`registered` → active, else withdrawn)     |
 * | persons/{id}                | professor / student (credential `bannerId` / `colleaguePersonId`) |
 *
 * Per-section failures (one section's events or registrations cannot be read) mark the run partial
 * and skip that section; failures on the period or the section list fail the run.
 */
import { CanonicalBuilder, WEEKDAYS, isoDate, localTime } from './canonical.js';
import { ConnectorError, arr, obj, str, type ConnectorHttp, type Json } from './http.js';
import { mapLimit, type Connector, type ConnectorConfig, type PullContext, type PullResult } from './types.js';

const DEFAULT_TZ = 'America/Sao_Paulo';

/** Media type versions per resource (Ethos data model versions). */
export const ETHOS_VERSIONS: Record<string, string> = {
  'academic-periods': '16',
  sections: '16',
  courses: '16',
  subjects: '6',
  'instructional-events': '11',
  'section-instructors': '10',
  'section-registrations': '16',
  persons: '12',
  rooms: '10',
};

export class EthosConnector implements Connector {
  private readonly cache = new Map<string, Promise<Json | null>>();

  constructor(
    readonly type: 'banner' | 'colleague',
    private readonly config: ConnectorConfig,
    private readonly http: ConnectorHttp,
  ) {}

  private headers(resource: string): Record<string, string> {
    const v = ETHOS_VERSIONS[resource] ?? '1';
    return { accept: `application/vnd.hedtech.integration.v${v}+json` };
  }

  private path(resource: string): string {
    return this.config.mappings.paths[resource] ?? `/api/${resource}`;
  }

  async list(resource: string, criteria?: Json): Promise<Json[]> {
    const limit = this.config.mappings.pageSize;
    const out: Json[] = [];
    for (let offset = 0; offset < 10_000_000; ) {
      const res = await this.http.get(this.path(resource), {
        headers: this.headers(resource),
        query: {
          offset,
          limit,
          ...(criteria ? { criteria: JSON.stringify(criteria) } : {}),
        },
      });
      this.http.stats.pages++;
      const page = arr(res.body).map(obj);
      out.push(...page);
      offset += page.length;
      const total = Number(res.headers.get('x-total-count'));
      if (page.length === 0 || (Number.isFinite(total) ? offset >= total : page.length < limit)) return out;
    }
    throw new ConnectorError('paging_runaway', `${resource}: too many records`);
  }

  /** Cached `GET /api/{resource}/{id}`; `null` when the record does not exist. */
  one(resource: string, id: string): Promise<Json | null> {
    const key = `${resource}/${id}`;
    let p = this.cache.get(key);
    if (!p) {
      p = this.http
        .get(`${this.path(resource)}/${encodeURIComponent(id)}`, {
          headers: this.headers(resource),
          allowStatus: [404],
        })
        .then((r) => (r.status === 404 ? null : obj(r.body)));
      this.cache.set(key, p);
    }
    return p;
  }

  private credentialType(): string {
    return this.type === 'banner' ? 'bannerId' : 'colleaguePersonId';
  }

  private personFields(p: Json): { externalId: string | undefined; name: string | undefined; email: string | undefined } {
    const credential = arr(p['credentials'])
      .map(obj)
      .find((c) => str(c['type']) === this.credentialType());
    const names = arr(p['names']).map(obj);
    const name = names.find((n) => str(n['preference']) === 'preferred') ?? names[0] ?? {};
    const fullName =
      str(name['fullName']) ?? [str(name['firstName']), str(name['lastName'])].filter(Boolean).join(' ');
    const emails = arr(p['emails']).map(obj);
    const email =
      emails.find((e) => str(e['preference']) === 'primary') ?? emails[0] ?? {};
    return {
      externalId: str(credential?.['value']) ?? str(p['id']),
      name: fullName || undefined,
      email: str(email['address'])?.toLowerCase(),
    };
  }

  private async course(b: CanonicalBuilder, courseId: string, path: string): Promise<string | null> {
    const course = await this.one('courses', courseId);
    if (!course) {
      b.warn(path, 'connector.unknown_course', `course ${courseId} not found`);
      return null;
    }
    const subjectId = str(obj(course['subject'])['id']);
    const subject = subjectId ? await this.one('subjects', subjectId) : null;
    const number = str(course['number']) ?? '';
    const code = `${str(subject?.['abbreviation']) ?? ''}${number}` || courseId;
    const title = arr(course['titles']).map(obj)[0];
    b.addCourse({
      externalId: courseId,
      code: code.slice(0, 50),
      name: (str(title?.['value']) ?? code).slice(0, 255),
      discipline: (str(subject?.['title']) ?? this.config.mappings.defaultDiscipline).slice(0, 100),
    });
    return courseId;
  }

  private async room(roomId: string): Promise<string | undefined> {
    const rooms = this.config.mappings.rooms;
    if (rooms[roomId]) return rooms[roomId];
    const room = await this.one('rooms', roomId);
    const number = str(room?.['number']);
    return number ? rooms[number] : undefined;
  }

  async pull(_ctx: PullContext): Promise<PullResult> {
    const m = this.config.mappings;
    const tz = m.timezone ?? DEFAULT_TZ;
    if (!m.termExternalId)
      throw new ConnectorError('invalid_config', 'mappings.termExternalId (academic period id) is required');
    const b = new CanonicalBuilder();

    const period = await this.one('academic-periods', m.termExternalId);
    if (!period) throw new ConnectorError('term_not_found', `academic period ${m.termExternalId} not found`);
    const startDate = isoDate(str(period['startOn']));
    const endDate = isoDate(str(period['endOn']));
    if (!startDate || !endDate)
      throw new ConnectorError('invalid_upstream_data', 'academic period has no startOn/endOn');
    const term = {
      externalId: str(period['code']) ?? m.termExternalId,
      name: str(period['title']) ?? str(period['code']) ?? m.termExternalId,
      startDate,
      endDate,
    };

    const sections = await this.list('sections', { academicPeriod: { id: m.termExternalId } });
    await mapLimit(sections, m.concurrency, async (s, i) => {
      const path = `sections[${i}]`;
      const sectionId = str(s['id']);
      if (!sectionId) return;
      const externalId = str(s['code']) ?? sectionId;
      try {
        const courseId = str(obj(s['course'])['id']);
        const courseExt = courseId ? await this.course(b, courseId, path) : null;
        if (!courseExt) return;

        const [events, instructors] = await Promise.all([
          this.list('instructional-events', { section: { id: sectionId } }),
          this.list('section-instructors', { section: { id: sectionId } }),
        ]);
        const instructor =
          instructors.find((x) => str(x['instructorRole']) === 'primary') ?? instructors[0];
        const instructorId = str(obj(instructor?.['instructor'])['id']);
        const person = instructorId ? await this.one('persons', instructorId) : null;
        const professor = person ? b.addProfessor(`${path}.instructor`, this.personFields(person)) : null;

        const schedule: { dayOfWeek: number; startTime: string; endTime: string; classroomId: string }[] = [];
        for (const [j, ev] of events.entries()) {
          const rec = obj(ev['recurrence']);
          const period = obj(rec['timePeriod']);
          const rule = obj(rec['repeatRule']);
          const start = localTime(str(period['startOn']) ?? '', tz);
          const end = localTime(str(period['endOn']) ?? '', tz);
          const roomId = arr(ev['locations'])
            .map((l) => str(obj(obj(obj(l)['location'])['room'])['id']))
            .find(Boolean);
          const evPath = `${path}.instructionalEvents[${j}]`;
          if (str(rule['type']) !== 'weekly' || !start || !end || end <= start) {
            b.warn(evPath, 'connector.invalid_slot', 'only weekly instructional events with times are imported');
            continue;
          }
          const classroomId = roomId ? await this.room(roomId) : undefined;
          if (!classroomId) {
            b.warn(evPath, 'connector.unmapped_room', `room ${roomId ?? '(none)'} is not mapped; slot skipped`);
            continue;
          }
          for (const day of arr(rule['daysOfWeek'])) {
            const d = WEEKDAYS.indexOf(String(day).toLowerCase());
            if (d >= 0) schedule.push({ dayOfWeek: d, startTime: start, endTime: end, classroomId });
          }
        }

        if (!b.addSection(path, {
          externalId,
          courseExternalId: courseExt,
          professorExternalId: professor ?? '',
          sectionCode: (str(s['number']) ?? externalId).slice(0, 50),
          schedule,
        }))
          return;

        const registrations = await this.list('section-registrations', { section: { id: sectionId } });
        for (const [j, r] of registrations.entries()) {
          const registrantId = str(obj(r['registrant'])['id']);
          if (!registrantId) continue;
          const student = await this.one('persons', registrantId);
          if (!student) {
            b.warn(`${path}.registrations[${j}]`, 'connector.unknown_person', `person ${registrantId} not found`);
            continue;
          }
          const ext = b.addStudent(`${path}.registrations[${j}]`, this.personFields(student));
          if (!ext) continue;
          const st = obj(r['status']);
          const reason = str(st['sectionRegistrationStatusReason']);
          const status =
            str(st['registrationStatus']) === 'registered'
              ? 'active'
              : reason === 'completed'
                ? 'completed'
                : 'withdrawn';
          b.addEnrollment(ext, externalId, status);
        }
      } catch (err) {
        if (!(err instanceof ConnectorError)) throw err;
        b.failed(path, `section ${externalId}: ${err.message}`);
      }
    });

    return {
      payload: b.build({ term, timezone: m.timezone }),
      warnings: b.warnings,
      partial: b.partial,
      // Ethos list filters are per resource and version; every sync is a full pull of the period.
      stats: { ...this.http.stats, incremental: false },
    };
  }
}
