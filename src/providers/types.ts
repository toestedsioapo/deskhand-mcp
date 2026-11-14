/** ISO-8601 UTC instants. */
export interface TimeRange {
  start: string;
  end: string;
}

/**
 * `allDay: false`: `start` and `end` are UTC instants. `allDay: true`: they are
 * calendar dates `YYYY-MM-DD`, `end` exclusive, `start < end`, no time zone.
 */
export interface EventRef {
  id: string;
  etag: string;
  title: string;
  start: string;
  end: string;
  attendees: string[];
  allDay: boolean;
}

/** What a provider holds under one event id. */
export type EventLookup = { state: "absent" } | { state: "cancelled" } | { state: "present"; event: EventRef };

export interface NewCalendarEvent {
  title: string;
  start: string;
  end: string;
  attendees: string[];
  sendUpdates: "none" | "all" | "externalOnly";
  calendarId: string;
  /** IANA zone name. Passed through to the provider; the fixture ignores it. */
  timeZone?: string;
}

/**
 * The only door to a calendar. The only write is
 * createEvent, and it is called only from the apply engine.
 */
export interface CalendarProvider {
  freeBusy(calendarId: string, range: TimeRange): Promise<{ busy: TimeRange[] }>;
  /** null when the event does not exist or was deleted (cancelled). */
  getEvent(calendarId: string, id: string): Promise<EventRef | null>;
  /**
   * Like getEvent, but tells "never existed" apart from "existed and was deleted". Used only by the apply engine to
   * look up the event under an action's idempotency key: a deleted one must not be created again.
   */
  lookupEvent(calendarId: string, id: string): Promise<EventLookup>;
  /**
   * Events overlapping `range`, sorted by start then id, at most `limit`;
   * `truncated` is true when more exist.
   */
  listEvents(
    calendarId: string,
    range: TimeRange,
    limit: number,
  ): Promise<{ events: EventRef[]; truncated: boolean }>;
  /**
   * Creates the event under an id derived from `idempotencyKey`. Calling it
   * again with a key that already exists MUST return the existing event: it
   * must not throw and must not create a duplicate (apply recovery and
   * concurrent applies rely on this). The existing event is returned as stored, even if it differs from `event`
   * (the apply engine compares it with the plan). A key whose event was deleted is never re-created: that throws a
   * ProviderError with the EVENT_DELETED phrase.
   */
  createEvent(event: NewCalendarEvent, idempotencyKey: string): Promise<EventRef>;
}
