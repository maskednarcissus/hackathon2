import type pg from 'pg';
import { seedOrganization } from './pg.js';

export const IDS = {
  holding: '10000000-0000-4000-8000-000000000000',
  institution: '11111111-1111-4111-8111-111111111111',
  campus: '12000000-0000-4000-8000-000000000000',
  classroom: '13000000-0000-4000-8000-000000000000',
  program: '14000000-0000-4000-8000-000000000000',
  term: '15000000-0000-4000-8000-000000000000',
  course: '16000000-0000-4000-8000-000000000000',
  professor: '77777777-7777-4777-8777-777777777777',
  section: '55555555-5555-4555-8555-555555555555',
  scheduledClass: 'c0000000-0000-4000-8000-000000000003',
  device: '17000000-0000-4000-8000-000000000000',
  recordings: ['a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002'],
} as const;

/** Full foreign-key chain from holding company to recording sessions. */
export async function seedAcademicChain(pool: pg.Pool): Promise<void> {
  await seedOrganization(pool, {
    holdingId: IDS.holding,
    institutionId: IDS.institution,
    campusId: IDS.campus,
    classroomIds: [IDS.classroom],
  });
  await pool.query(
    `INSERT INTO academic_programs (id, institution_id, name, code) VALUES ($1, $2, 'Direito', 'DIR')`,
    [IDS.program, IDS.institution],
  );
  await pool.query(
    `INSERT INTO academic_terms (id, institution_id, name, start_date, end_date) VALUES ($1, $2, '2026/2', '2026-08-03', '2026-12-11')`,
    [IDS.term, IDS.institution],
  );
  await pool.query(
    `INSERT INTO courses (id, institution_id, academic_program_id, academic_term_id, code, name, discipline)
     VALUES ($1, $2, $3, $4, 'ECO201', 'Macroeconomia', 'economics')`,
    [IDS.course, IDS.institution, IDS.program, IDS.term],
  );
  await pool.query(
    `INSERT INTO professors (id, institution_id, name, email) VALUES ($1, $2, 'Ana Souza', 'ana@uni.example')`,
    [IDS.professor, IDS.institution],
  );
  await pool.query(
    `INSERT INTO class_sections (id, course_id, professor_id, section_code) VALUES ($1, $2, $3, 'A')`,
    [IDS.section, IDS.course, IDS.professor],
  );
  await pool.query(
    `INSERT INTO scheduled_classes (id, class_section_id, classroom_id, starts_at, ends_at)
     VALUES ($1, $2, $3, '2026-11-04T22:00:00Z', '2026-11-04T23:40:00Z')`,
    [IDS.scheduledClass, IDS.section, IDS.classroom],
  );
  await pool.query(
    `INSERT INTO capture_devices (id, classroom_id, serial_number, model, firmware_version, institution_id, public_key_pem,
        public_key_fingerprint, certificate, certificate_issued_at, certificate_expires_at)
     VALUES ($1, $2, 'CI-TEST-1', 'ci-capture-a1', '1.0.0', $3, 'pem', 'sha256:test', 'cert', NOW(), NOW() + interval '1 year')`,
    [IDS.device, IDS.classroom, IDS.institution],
  );
  for (const rec of IDS.recordings) {
    await pool.query(
      `INSERT INTO recording_sessions (id, device_id, classroom_id, scheduled_class_id, started_at, audio_format, sample_rate, channels)
       VALUES ($1, $2, $3, $4, '2026-11-04T21:55:00Z', 'wav_pcm_s16le', 16000, 1)`,
      [rec, IDS.device, IDS.classroom, IDS.scheduledClass],
    );
  }
}
