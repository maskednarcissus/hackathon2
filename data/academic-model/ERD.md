# Academic Data Model & Entity Relationship Diagram (ERD)

This document visualizes the canonical operational schema for the **Classroom Intelligence** platform, as defined in `V001__initial_academic_schema.sql`.

## Entity-Relationship Diagram

```mermaid
erDiagram
    HOLDING-COMPANIES ||--o{ INSTITUTIONS : owns
    INSTITUTIONS ||--o{ CAMPUSES : operates
    INSTITUTIONS ||--o{ DEPARTMENTS : contains
    INSTITUTIONS ||--o{ ACADEMIC-TERMS : schedules
    INSTITUTIONS ||--o{ ACADEMIC-PROGRAMS : offers
    INSTITUTIONS ||--o{ PROFESSORS : employs
    INSTITUTIONS ||--o{ STUDENTS : enrolls
    INSTITUTIONS ||--o{ RECORDING-POLICIES : enforces

    CAMPUSES ||--o{ CLASSROOMS : houses
    CLASSROOMS ||--o{ SCHEDULED-CLASSES : hosts
    CLASSROOMS ||--o| CAPTURE-DEVICES : equipped_with

    ACADEMIC-PROGRAMS ||--o{ COURSES : curriculum
    ACADEMIC-TERMS ||--o{ COURSES : active_in
    COURSES ||--o{ CLASS-SECTIONS : partitioned_into
    PROFESSORS ||--o{ CLASS-SECTIONS : teaches

    STUDENTS ||--o{ ENROLLMENTS : registers
    CLASS-SECTIONS ||--o{ ENROLLMENTS : registers
    CLASS-SECTIONS ||--o{ SCHEDULED-CLASSES : scheduled_as

    CAPTURE-DEVICES ||--o{ RECORDING-SESSIONS : records
    SCHEDULED-CLASSES ||--o{ RECORDING-SESSIONS : captured_by
    RECORDING-POLICIES ||--o{ RECORDING-SESSIONS : governs
    RECORDING-SESSIONS ||--o{ AUDIO-SEGMENTS : split_into
    RECORDING-SESSIONS ||--o{ CAPTURE-INCIDENTS : experiences

    RECORDING-SESSIONS ||--o| TRANSCRIPTS : transcribed_into
    TRANSCRIPTS ||--o{ TRANSCRIPT-SEGMENTS : contains
    TRANSCRIPT-SEGMENTS ||--o{ TRANSCRIPT-CORRECTIONS : modified_by
    TRANSCRIPTS ||--o{ SPEAKERS : attributes

    SCHEDULED-CLASSES ||--o| LECTURE-SUMMARIES : distilled_into
    TRANSCRIPTS ||--o| LECTURE-SUMMARIES : synthesizes
    LECTURE-SUMMARIES ||--o{ LECTURE-TOPICS : outlines
    LECTURE-SUMMARIES ||--o{ CONCEPTS : defines
    LECTURE-SUMMARIES ||--o{ QUESTIONS : catalogs
    LECTURE-SUMMARIES ||--o{ READING-REFERENCES : recommends

    TRANSCRIPT-SEGMENTS ||--o{ EXTRACTED-EVENTS : derives
    SCHEDULED-CLASSES ||--o{ EXTRACTED-EVENTS : contextualizes
    COURSES ||--o{ EXTRACTED-EVENTS : pertains_to
    EXTRACTED-EVENTS ||--o{ EVENT-CONFIRMATIONS : validated_by
    EXTRACTED-EVENTS ||--o{ EVENT-CHANGES : tracks_modifications

    EXTRACTED-EVENTS ||--o| CALENDAR-EVENTS : creates
    COURSES ||--o{ CALENDAR-EVENTS : scopes
    STUDENTS ||--o{ STUDENT-CALENDAR-EVENTS : syncs
    CALENDAR-EVENTS ||--o{ STUDENT-CALENDAR-EVENTS : aggregates

    STUDENTS ||--o{ NOTIFICATIONS : receives
    PROFESSORS ||--o{ NOTIFICATIONS : receives
    STUDENTS ||--o{ CONTENT-INTERACTIONS : tracks_engagement
    RECORDING-POLICIES ||--o{ RECORDING-CONSENTS : requires
    INSTITUTIONS ||--o{ AUDIT-EVENTS : tenant_logs
```

## Schema Domains & Tables

### 1. Organizational & Institutional Hierarchy

- **`holding_companies`**: Multi-tenant holding conglomerates.
- **`institutions`**: Accredited academic entities/brands.
- **`campuses`**: Physical or regional campuses with distinct timezones.
- **`departments`**: Academic units (e.g., School of Medicine, Dept of Law).

### 2. Academic Core

- **`academic_terms`**: Semesters, trimesters, or annual periods.
- **`academic_programs`**: Degree programs (undergrad, grad, certification).
- **`courses`**: Course catalog entries bound to a term and curriculum.
- **`professors` & `students`**: Individual academic actors.
- **`classrooms`**: Physical instructional spaces.
- **`class_sections`**: Specific cohorts/classes led by a professor.
- **`enrollments`**: Student-to-section junction with status tracking.
- **`scheduled_classes`**: Individual calendar timetable occurrences.

### 3. Capture & Hardware Fleet

- **`capture_devices`**: Secure IoT audio array units, firmware versions, health status.
- **`device_assignments`**: Historical audit log of classroom deployments.
- **`recording_policies`**: LGPD legal basis, explicit consent flags, retention rules.
- **`recording_sessions`**: Captured audio sessions, file checksums, upload state.
- **`audio_segments`**: Chunks with start/end millisecond offsets.
- **`capture_incidents`**: Fleet diagnostics and failure tracking.

### 4. Transcription & Diarization

- **`transcripts`**: Consolidated transcript entity with WER and version.
- **`transcript_segments`**: Fine-grained timestamped passages with confidence and language.
- **`transcript_corrections`**: Non-destructive correction audit trail.
- **`speakers`**: Diarization clusters (Speaker 1, Speaker 2) with confidence.

### 5. Lecture Intelligence

- **`lecture_summaries`**: Executive summaries, topic models, processing version.
- **`lecture_topics`**: Hierarchical outline with start/end millisecond markers.
- **`concepts`**: Term, definition, and concrete pedagogical examples.
- **`questions`**: In-class student questions and professor explanations.
- **`reading_references`**: Referenced books, articles, legislation, and URLs.

### 6. Event Extraction & Calendar

- **`extracted_events`**: High-stakes announcements (exams, deadlines, syllabus shifts) with multi-dimensional confidence scores.
- **`event_confirmations`**: Professor review queue responses (confirm, edit, reject).
- **`event_changes`**: Audit delta tracking shifts in dates or descriptions.
- **`calendar_events`**: Verified events on course/institutional calendars.
- **`student_calendar_events`**: Student-personalized calendar associations.

### 7. Governance, Consent & Audit

- **`recording_consents`**: Student/professor consent records under LGPD Art. 7/8.
- **`audit_events`**: Immutable append-only log of all critical system actions.
- **`content_interactions`**: Learning analytics and student engagement metrics.
