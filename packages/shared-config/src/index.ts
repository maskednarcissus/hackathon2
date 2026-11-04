export const APP_VERSION = '0.1.0';

export const SUPPORTED_LANGUAGES = ['pt-BR', 'pt', 'en'] as const;
export type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number];

export const DEFAULT_LANGUAGE: SupportedLanguage = 'pt-BR';

export const CONFIDENCE_THRESHOLDS = {
  AUTO_PUBLISH: 0.92,
  PROFESSOR_REVIEW: 0.70,
  ADMIN_REVIEW: 0.50,
  DISCARD: 0.30,
} as const;

export const RETENTION_DEFAULTS_DAYS = {
  RAW_AUDIO: 90,
  TRANSCRIPT: 365,
  LECTURE_SUMMARY: 730,
  EXTRACTED_EVENT: 1825,
  AUDIT_LOG: 2555,
} as const;
