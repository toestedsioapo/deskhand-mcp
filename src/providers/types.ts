/** ISO-8601 UTC instants. */
export interface TimeRange {
  start: string;
  end: string;
}

export interface EventRef {
  id: string;
  etag: string;
  title: string;
  start: string;
  end: string;
  attendees: string[];
}

export interface NewCalendarEvent {
  title: string;
  start: string;
  end: string;
  attendees: string[];
  sendUpdates: "none" | "all" | "externalOnly";
  calendarId: string;
}

/**
 * The only door to a calendar. No list/find methods yet (M3). The only write is
 * createEvent, and it is called only from the apply engine.
 */
export interface CalendarProvider {
  freeBusy(calendarId: string, range: TimeRange): Promise<{ busy: TimeRange[] }>;
  getEvent(calendarId: string, id: string): Promise<EventRef | null>;
  /**
   * Creates the event under an id derived from `idempotencyKey`. Calling it
   * again with a key that already exists MUST return the existing event: it
   * must not throw and must not create a duplicate (apply recovery and
   * concurrent applies rely on this).
   */
  createEvent(event: NewCalendarEvent, idempotencyKey: string): Promise<EventRef>;
}
