/** Organizational hierarchy */
export interface HoldingCompany {
  id: string;
  name: string;
  createdAt: Date;
}

export interface Institution {
  id: string;
  holdingCompanyId: string;
  name: string;
  brand?: string;
  createdAt: Date;
}

export interface Campus {
  id: string;
  institutionId: string;
  name: string;
  timezone: string;
  createdAt: Date;
}

export interface AcademicTerm {
  id: string;
  institutionId: string;
  name: string;
  startDate: string; // ISO 8601
  endDate: string;   // ISO 8601
}

export interface Course {
  id: string;
  institutionId: string;
  academicTermId: string;
  code: string;
  name: string;
  discipline: string;
}

export interface ClassSection {
  id: string;
  courseId: string;
  professorId: string;
  classroomId: string;
  schedule: ClassSchedule[];
}

export interface ClassSchedule {
  dayOfWeek: number; // 0 = Sunday
  startTime: string; // HH:mm
  endTime: string;
}

export interface Professor {
  id: string;
  institutionId: string;
  name: string;
  email: string;
}

export interface Student {
  id: string;
  institutionId: string;
  name: string;
  email: string;
}

export interface Enrollment {
  id: string;
  studentId: string;
  classSectionId: string;
  enrolledAt: Date;
}
