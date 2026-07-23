// ─── Platform Roles — Web Panel Only ─────────────────────────
export const PLATFORM_ROLES = ["SUPER_ADMIN", "SCHOOL_ADMIN"] as const;

// ─── App Roles — Mobile Only ──────────────────────────────────
export const STAFF_ROLES = [
  "SYSTEM_ADMIN",
  "TEACHER",
  "FRONT_OFFICE",
  "ACCOUNTANT",
  "HR_EXECUTIVE",
  "LIBRARIAN",
  "INVENTORY_MANAGER",
  "HOSTEL_WARDEN",
  "TRANSPORT_MANAGER",
  "EXAM_COORDINATOR",
] as const;

export type PlatformRole = typeof PLATFORM_ROLES[number];
export type StaffRole    = typeof STAFF_ROLES[number];
export type LoginAs      = "STAFF" | "STUDENT" | "PARENT";

// ─── Checkers ────────────────────────────────────────────────
export const isPlatformRole  = (role: string): role is PlatformRole =>
  PLATFORM_ROLES.includes(role as PlatformRole);

export const isSchoolAdmin   = (role: string) => role === "SCHOOL_ADMIN";
export const isSuperAdmin    = (role: string) => role === "SUPER_ADMIN";

export const isStaffRole     = (role: string): role is StaffRole =>
  STAFF_ROLES.includes(role as StaffRole);

export const isStudentRole   = (role: string) => role === "STUDENT";
export const isParentRole    = (role: string) => role === "PARENT";

// Mobile app mein login allowed?
export const isAppLoginAllowed = (role: string): boolean =>
  isStaffRole(role) || isStudentRole(role) || isParentRole(role);

export const getLoginAs = (role: string): LoginAs => {
  if (isStaffRole(role))   return "STAFF";
  if (isStudentRole(role)) return "STUDENT";
  return "PARENT";
};

// ─── Role Labels ─────────────────────────────────────────────
export const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN:        "Super Admin",
  SCHOOL_ADMIN:       "School Admin",
  SYSTEM_ADMIN:       "System Admin",
  TEACHER:            "Teacher",
  FRONT_OFFICE:       "Front Office",
  ACCOUNTANT:         "Accountant",
  HR_EXECUTIVE:       "HR Executive",
  LIBRARIAN:          "Librarian",
  INVENTORY_MANAGER:  "Inventory Manager",
  HOSTEL_WARDEN:      "Hostel Warden",
  TRANSPORT_MANAGER:  "Transport Manager",
  EXAM_COORDINATOR:   "Exam Coordinator",
  STUDENT:            "Student",
  PARENT:             "Parent",
};

export const getRoleLabel = (role: string) => ROLE_LABELS[role] ?? role;