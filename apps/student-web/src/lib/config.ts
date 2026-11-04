/** Upstream service base URLs (server-side only). */
function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value !== undefined && value !== '' ? value.replace(/\/$/, '') : fallback;
}

export const services = {
  identity: env('IDENTITY_URL', 'http://localhost:4001'),
  academicIntegration: env('ACADEMIC_INTEGRATION_URL', 'http://localhost:4003'),
  calendar: env('CALENDAR_URL', 'http://localhost:4005'),
  notifications: env('NOTIFICATIONS_URL', 'http://localhost:4006'),
  transcripts: env('TRANSCRIPT_MANAGEMENT_URL', 'http://localhost:4008'),
  audit: env('AUDIT_URL', 'http://localhost:4011'),
  lectures: env('LECTURE_INTELLIGENCE_URL', 'http://localhost:8006'),
} as const;

export type ServiceName = keyof typeof services;

/** Public base URL of the calendar service, used to build ICS subscription links. */
export const calendarPublicUrl = env('CALENDAR_PUBLIC_URL', services.calendar);

export const DEFAULT_TIMEZONE = 'America/Sao_Paulo';

export const SESSION_COOKIES = {
  access: 'ci_at',
  refresh: 'ci_rt',
} as const;

/** Secure cookies everywhere except when explicitly disabled for plain-http testing. */
export const COOKIE_SECURE = process.env['COOKIE_INSECURE'] !== '1';
