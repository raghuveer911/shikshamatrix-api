import { Permission, PERMISSIONS } from "./permissions";

export interface MenuItem {
  key:         string;
  label:       string;
  icon:        string;
  route:       string;
  permission?: Permission;   // null = always show
  children?:   MenuItem[];
}

// ─── Full menu definition ─────────────────────────────────────
export const ALL_MENUS: MenuItem[] = [
  {
    key: "students", label: "Students", icon: "people-outline",
    route: "/(staff)/students", permission: PERMISSIONS.STUDENTS_VIEW,
  },
  {
    key: "attendance", label: "Attendance", icon: "calendar-outline",
    route: "/(staff)/attendance", permission: PERMISSIONS.ATTENDANCE_VIEW,
  },
  {
    key: "academics", label: "Academics", icon: "book-outline",
    route: "/(staff)/academics", permission: PERMISSIONS.MARKS_VIEW,
    children: [
      { key: "marks",    label: "Marks Entry", icon: "create-outline",
        route: "/(staff)/academics/marks",    permission: PERMISSIONS.MARKS_CREATE },
      { key: "homework", label: "Homework",    icon: "document-text-outline",
        route: "/(staff)/academics/homework", permission: PERMISSIONS.HOMEWORK_VIEW },
      { key: "exams",    label: "Exams",       icon: "trophy-outline",
        route: "/(staff)/academics/exams",    permission: PERMISSIONS.EXAMS_VIEW },
    ],
  },
  {
    key: "finance", label: "Finance", icon: "cash-outline",
    route: "/(staff)/finance", permission: PERMISSIONS.FEES_VIEW,
    children: [
      { key: "fees",     label: "Fee Collection", icon: "wallet-outline",
        route: "/(staff)/finance/fees",     permission: PERMISSIONS.FEES_COLLECT },
      { key: "payroll",  label: "Payroll",        icon: "card-outline",
        route: "/(staff)/finance/payroll",  permission: PERMISSIONS.PAYROLL_VIEW },
      { key: "expenses", label: "Expenses",       icon: "receipt-outline",
        route: "/(staff)/finance/expenses", permission: PERMISSIONS.EXPENSES_VIEW },
    ],
  },
  {
    key: "hr", label: "HR", icon: "briefcase-outline",
    route: "/(staff)/hr", permission: PERMISSIONS.STAFF_VIEW,
    children: [
      { key: "staff",  label: "Staff",      icon: "people-outline",
        route: "/(staff)/hr/staff",  permission: PERMISSIONS.STAFF_VIEW },
      { key: "leaves", label: "Leaves",     icon: "time-outline",
        route: "/(staff)/hr/leaves", permission: PERMISSIONS.LEAVES_VIEW },
    ],
  },
  {
    key: "library", label: "Library", icon: "library-outline",
    route: "/(staff)/library", permission: PERMISSIONS.LIBRARY_VIEW,
  },
  {
    key: "inventory", label: "Inventory", icon: "cube-outline",
    route: "/(staff)/inventory", permission: PERMISSIONS.INVENTORY_VIEW,
  },
  {
    key: "transport", label: "Transport", icon: "bus-outline",
    route: "/(staff)/transport", permission: PERMISSIONS.TRANSPORT_VIEW,
  },
  {
    key: "hostel", label: "Hostel", icon: "home-outline",
    route: "/(staff)/hostel", permission: PERMISSIONS.HOSTEL_VIEW,
  },
  {
    key: "frontoffice", label: "Front Office", icon: "storefront-outline",
    route: "/(staff)/frontoffice", permission: PERMISSIONS.ENQUIRIES_VIEW,
  },
  {
    key: "notices", label: "Notices", icon: "megaphone-outline",
    route: "/(staff)/notices", permission: PERMISSIONS.NOTICES_VIEW,
  },
  {
    key: "reports", label: "Reports", icon: "bar-chart-outline",
    route: "/(staff)/reports", permission: PERMISSIONS.REPORTS_VIEW,
  },
  {
    key: "settings", label: "Settings", icon: "settings-outline",
    route: "/(staff)/settings", permission: PERMISSIONS.SETTINGS_VIEW,
  },
];

// ─── Filter menus based on permissions ───────────────────────
export function buildMenu(userPermissions: Permission[]): MenuItem[] {
  return ALL_MENUS
    .filter(item =>
      !item.permission || userPermissions.includes(item.permission)
    )
    .map(item => ({
      ...item,
      children: item.children?.filter(child =>
        !child.permission || userPermissions.includes(child.permission)
      ),
    }));
}