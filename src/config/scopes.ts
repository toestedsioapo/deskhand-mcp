/** OAuth scopes (ADR 0007 addendum): M3 requests Calendar scopes only. */
export const SCOPE_CALENDAR_READ = "https://www.googleapis.com/auth/calendar.readonly";
export const SCOPE_CALENDAR_WRITE = "https://www.googleapis.com/auth/calendar.events";

/** The minimum scope set: read only, or read plus write when writes are enabled. */
export function requestedScopes(writesEnabled: boolean): string[] {
  return writesEnabled ? [SCOPE_CALENDAR_READ, SCOPE_CALENDAR_WRITE] : [SCOPE_CALENDAR_READ];
}
