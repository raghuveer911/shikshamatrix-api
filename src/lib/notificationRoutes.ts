// apps/mobile/src/lib/notificationRoutes.ts
//
// The backend sends `actionUrl` on each Notification as a plain path +
// query string, e.g. "/parent/fees?studentId=42" or
// "/parent/attendance?studentId=42&date=2026-08-06" — it mirrors the
// backend API route names, not this app's actual expo-router paths
// (which live under the "(parent)" group and don't always match 1:1 —
// e.g. attendance is really "/(parent)/more/attendance", not
// "/(parent)/attendance"). It also can't know that these screens read
// "which child" from a global store rather than the URL.
//
// This file is the one place that translates a backend actionUrl into
// (a) the real screen to push, and (b) any child-store selection that
// needs to happen first so the screen shows the right student.
import { useChildStore } from "@/store/childStore";

export interface ResolvedNotificationRoute {
  /** expo-router path to push, already includes the "(parent)" segment
   *  the way the rest of this app pushes routes. */
  path: string;
  /** Extra params to forward as a query string on the push, for
   *  screens that DO read from the URL (e.g. a specific date). */
  params?: Record<string, string>;
}

/** category → real screen. Extend this as more notification types get
 *  actionUrls (exam results, homework, etc.) — keeps the mapping in
 *  one place instead of scattered through the inbox UI. */
const ROUTE_MAP: { match: RegExp; path: string; forward?: string[] }[] = [
  { match: /^\/parent\/fees/, path: "/(parent)/fees" },
  { match: /^\/parent\/attendance/, path: "/(parent)/more/attendance", forward: ["date"] },
];

/**
 * Parses a backend actionUrl, selects the right child in the shared
 * child store if a studentId is present, and returns where to
 * navigate. Returns null for actionUrls this app doesn't have a
 * screen for yet (e.g. a category not built on mobile) — callers
 * should just no-op the tap in that case rather than crash.
 */
export function resolveNotificationRoute(actionUrl?: string | null): ResolvedNotificationRoute | null {
  if (!actionUrl) return null;

  let url: URL;
  try {
    url = new URL(actionUrl, "https://placeholder.local"); // base is only needed to satisfy URL()
  } catch {
    return null;
  }

  const rule = ROUTE_MAP.find((r) => r.match.test(url.pathname));
  if (!rule) return null;

  const studentId = url.searchParams.get("studentId");
  if (studentId && !Number.isNaN(Number(studentId))) {
    // Switch the app-wide selected child BEFORE navigating, so whichever
    // screen loads next reads the right student from the store — these
    // screens don't accept studentId as a route param themselves.
    useChildStore.getState().selectChild(Number(studentId));
  }

  const params: Record<string, string> = {};
  for (const key of rule.forward ?? []) {
    const v = url.searchParams.get(key);
    if (v) params[key] = v;
  }

  return { path: rule.path, params: Object.keys(params).length ? params : undefined };
}