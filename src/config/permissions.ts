// ─── All possible permissions ─────────────────────────────────
export const PERMISSIONS = {
  // Students
  STUDENTS_VIEW:        "students:view",
  STUDENTS_CREATE:      "students:create",
  STUDENTS_EDIT:        "students:edit",
  STUDENTS_DELETE:      "students:delete",

  // Attendance
  ATTENDANCE_VIEW:      "attendance:view",
  ATTENDANCE_CREATE:    "attendance:create",
  ATTENDANCE_EDIT:      "attendance:edit",

  // Marks
  MARKS_VIEW:           "marks:view",
  MARKS_CREATE:         "marks:create",
  MARKS_EDIT:           "marks:edit",

  // Homework / Assignments
  HOMEWORK_VIEW:        "homework:view",
  HOMEWORK_CREATE:      "homework:create",
  HOMEWORK_EDIT:        "homework:edit",

  // Finance
  FEES_VIEW:            "fees:view",
  FEES_COLLECT:         "fees:collect",
  FEES_REPORT:          "fees:report",
  PAYROLL_VIEW:         "payroll:view",
  PAYROLL_RUN:          "payroll:run",
  EXPENSES_VIEW:        "expenses:view",
  EXPENSES_CREATE:      "expenses:create",

  // HR
  STAFF_VIEW:           "staff:view",
  STAFF_CREATE:         "staff:create",
  LEAVES_VIEW:          "leaves:view",
  LEAVES_APPROVE:       "leaves:approve",

  // Exams
  EXAMS_VIEW:           "exams:view",
  EXAMS_CREATE:         "exams:create",
  RESULTS_VIEW:         "results:view",
  RESULTS_PUBLISH:      "results:publish",

  // Library
  LIBRARY_VIEW:         "library:view",
  LIBRARY_ISSUE:        "library:issue",
  LIBRARY_MANAGE:       "library:manage",

  // Inventory
  INVENTORY_VIEW:       "inventory:view",
  INVENTORY_MANAGE:     "inventory:manage",

  // Transport
  TRANSPORT_VIEW:       "transport:view",
  TRANSPORT_MANAGE:     "transport:manage",

  // Hostel
  HOSTEL_VIEW:          "hostel:view",
  HOSTEL_MANAGE:        "hostel:manage",

  // Front Office
  ENQUIRIES_VIEW:       "enquiries:view",
  ENQUIRIES_MANAGE:     "enquiries:manage",
  VISITORS_VIEW:        "visitors:view",
  VISITORS_MANAGE:      "visitors:manage",
  COMPLAINTS_VIEW:      "complaints:view",
  COMPLAINTS_MANAGE:    "complaints:manage",

  // Notices
  NOTICES_VIEW:         "notices:view",
  NOTICES_CREATE:       "notices:create",
  NOTICES_PUBLISH:      "notices:publish",

  // Reports
  REPORTS_VIEW:         "reports:view",
  REPORTS_EXPORT:       "reports:export",

  // Admin
  USERS_VIEW:           "users:view",
  USERS_MANAGE:         "users:manage",
  SETTINGS_VIEW:        "settings:view",
  SETTINGS_EDIT:        "settings:edit",
  ROLES_MANAGE:         "roles:manage",
} as const;

export type Permission = typeof PERMISSIONS[keyof typeof PERMISSIONS];

// ─── Default permissions per role ─────────────────────────────
export const ROLE_DEFAULT_PERMISSIONS: Record<string, Permission[]> = {
  SYSTEM_ADMIN: Object.values(PERMISSIONS), // all

  TEACHER: [
    PERMISSIONS.STUDENTS_VIEW,
    PERMISSIONS.ATTENDANCE_VIEW,
    PERMISSIONS.ATTENDANCE_CREATE,
    PERMISSIONS.ATTENDANCE_EDIT,
    PERMISSIONS.MARKS_VIEW,
    PERMISSIONS.MARKS_CREATE,
    PERMISSIONS.MARKS_EDIT,
    PERMISSIONS.HOMEWORK_VIEW,
    PERMISSIONS.HOMEWORK_CREATE,
    PERMISSIONS.HOMEWORK_EDIT,
    PERMISSIONS.EXAMS_VIEW,
    PERMISSIONS.RESULTS_VIEW,
    PERMISSIONS.NOTICES_VIEW,
    PERMISSIONS.LIBRARY_VIEW,
    PERMISSIONS.REPORTS_VIEW,
  ],

  FRONT_OFFICE: [
    PERMISSIONS.STUDENTS_VIEW,
    PERMISSIONS.ENQUIRIES_VIEW,
    PERMISSIONS.ENQUIRIES_MANAGE,
    PERMISSIONS.VISITORS_VIEW,
    PERMISSIONS.VISITORS_MANAGE,
    PERMISSIONS.COMPLAINTS_VIEW,
    PERMISSIONS.COMPLAINTS_MANAGE,
    PERMISSIONS.NOTICES_VIEW,
    PERMISSIONS.NOTICES_CREATE,
    PERMISSIONS.NOTICES_PUBLISH,
    PERMISSIONS.REPORTS_VIEW,
  ],

  ACCOUNTANT: [
    PERMISSIONS.STUDENTS_VIEW,
    PERMISSIONS.FEES_VIEW,
    PERMISSIONS.FEES_COLLECT,
    PERMISSIONS.FEES_REPORT,
    PERMISSIONS.PAYROLL_VIEW,
    PERMISSIONS.EXPENSES_VIEW,
    PERMISSIONS.EXPENSES_CREATE,
    PERMISSIONS.REPORTS_VIEW,
    PERMISSIONS.REPORTS_EXPORT,
  ],

  HR_EXECUTIVE: [
    PERMISSIONS.STAFF_VIEW,
    PERMISSIONS.STAFF_CREATE,
    PERMISSIONS.LEAVES_VIEW,
    PERMISSIONS.LEAVES_APPROVE,
    PERMISSIONS.PAYROLL_VIEW,
    PERMISSIONS.PAYROLL_RUN,
    PERMISSIONS.REPORTS_VIEW,
    PERMISSIONS.REPORTS_EXPORT,
  ],

  LIBRARIAN: [
    PERMISSIONS.STUDENTS_VIEW,
    PERMISSIONS.LIBRARY_VIEW,
    PERMISSIONS.LIBRARY_ISSUE,
    PERMISSIONS.LIBRARY_MANAGE,
    PERMISSIONS.REPORTS_VIEW,
  ],

  INVENTORY_MANAGER: [
    PERMISSIONS.INVENTORY_VIEW,
    PERMISSIONS.INVENTORY_MANAGE,
    PERMISSIONS.EXPENSES_VIEW,
    PERMISSIONS.REPORTS_VIEW,
  ],

  HOSTEL_WARDEN: [
    PERMISSIONS.STUDENTS_VIEW,
    PERMISSIONS.HOSTEL_VIEW,
    PERMISSIONS.HOSTEL_MANAGE,
    PERMISSIONS.ATTENDANCE_VIEW,
    PERMISSIONS.REPORTS_VIEW,
  ],

  TRANSPORT_MANAGER: [
    PERMISSIONS.STUDENTS_VIEW,
    PERMISSIONS.TRANSPORT_VIEW,
    PERMISSIONS.TRANSPORT_MANAGE,
    PERMISSIONS.REPORTS_VIEW,
  ],

  EXAM_COORDINATOR: [
    PERMISSIONS.STUDENTS_VIEW,
    PERMISSIONS.EXAMS_VIEW,
    PERMISSIONS.EXAMS_CREATE,
    PERMISSIONS.RESULTS_VIEW,
    PERMISSIONS.RESULTS_PUBLISH,
    PERMISSIONS.MARKS_VIEW,
    PERMISSIONS.REPORTS_VIEW,
    PERMISSIONS.REPORTS_EXPORT,
  ],
};