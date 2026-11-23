/** OAuth scopes (ADR 0007 addendum, M4b): Calendar and Gmail. Nothing that can send mail or modify a mailbox is ever requested. */
export const SCOPE_CALENDAR_READ = "https://www.googleapis.com/auth/calendar.readonly";
export const SCOPE_CALENDAR_WRITE = "https://www.googleapis.com/auth/calendar.events";
export const SCOPE_GMAIL_READ = "https://www.googleapis.com/auth/gmail.readonly";
export const SCOPE_GMAIL_COMPOSE = "https://www.googleapis.com/auth/gmail.compose";

/** The minimum scope set: read only, or read plus write when writes are enabled. */
export function requestedScopes(writesEnabled: boolean): string[] {
  const read = [SCOPE_CALENDAR_READ, SCOPE_GMAIL_READ];
  return writesEnabled ? [...read, SCOPE_CALENDAR_WRITE, SCOPE_GMAIL_COMPOSE] : read;
}
