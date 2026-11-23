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
  /** Without the calendar owner (see `ownerEmail`). */
  attendees: string[];
  allDay: boolean;
  /**
   * Plan-match fields, never shown by the read tools; each is present only when it holds. `ownerEmail`: the calendar
   * owner Google lists among the attendees (`self: true`), kept apart from `attendees`. `organizerSelf`: the calendar
   * owner organises the event (Google `organizer.self`; the fixture sets it on its writes and world events). `recurring`: a series
   * or an instance of one.
   */
  ownerEmail?: string;
  organizerSelf?: boolean;
  recurring?: boolean;
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

/** A mailbox address; `name` is "" when the header has no display name. */
export interface MailAddress {
  address: string;
  name: string;
}

export interface MailMessage {
  id: string;
  threadId: string;
  /** The RFC 5322 Message-ID header value (`<…>`), or null when the message has none. */
  messageIdHeader: string | null;
  /** ISO UTC instant. */
  date: string;
  from: MailAddress | null;
  replyTo: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  snippet: string;
  bodyText: string;
  bodyTruncated: boolean;
  unread: boolean;
  /** True only when the provider says the owner sent it (Gmail `SENT` label; fixture `sent: true`). A From header proves nothing. */
  sentByOwner: boolean;
}

/** Messages oldest first; drafts, trash and spam excluded. `truncated`: older messages were left out. */
export interface MailThread {
  id: string;
  messages: MailMessage[];
  truncated: boolean;
}

export interface ThreadSummary {
  id: string;
  subject: string;
  from: MailAddress | null;
  lastDate: string;
  snippet: string;
  messageCount: number;
  unread: boolean;
}

/** A draft reply as the apply engine asks for it. `messageIdHeader` is derived from the idempotency key. */
export interface NewDraft {
  threadId: string;
  messageIdHeader: string;
  inReplyTo: string | null;
  references: string[];
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

/** A draft as the provider holds it; the body is represented only by its SHA-256 (hex). */
export interface DraftRef {
  draftId: string;
  messageId: string;
  threadId: string;
  messageIdHeader: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodySha256: string;
}

/** What a provider holds under one Message-ID header. Drafts have no "deleted" state a provider can report. */
export type DraftLookup = { state: "absent" } | { state: "present"; draft: DraftRef };

/**
 * The only door to a mailbox. No send method, by design (ADR 0001, ADR 0007): Deskhand writes drafts only. The only
 * write is createDraft, and it is called only from the apply engine.
 */
export interface MailProvider {
  profile(): Promise<{ email: string }>;
  searchThreads(query: string, limit: number): Promise<{ threads: ThreadSummary[]; truncated: boolean }>;
  /** null when the thread does not exist. At most the newest `maxMessages` messages. */
  getThread(threadId: string, maxMessages: number): Promise<MailThread | null>;
  /**
   * Every message id of the thread except drafts, trash and spam, in no particular order and with no cap; null when
   * the thread does not exist. Ids only: no bodies or headers (M4b decision 7).
   */
  threadMessageIds(threadId: string): Promise<string[] | null>;
  /** The draft under this Message-ID. `threadId` is the plan's thread, so an adapter can also look there when search misses. */
  lookupDraft(messageIdHeader: string, threadId: string): Promise<DraftLookup>;
  /**
   * Writes the draft. On a provider with no unique key on the Message-ID (Gmail) this does not deduplicate: each call
   * can create a new draft, so the apply engine must look up under its write claim first. Only a provider that enforces
   * the key may return an existing draft instead.
   */
  createDraft(draft: NewDraft): Promise<DraftRef>;
}

/** Every provider a plan kind may use, handed over by the apply engine. */
export interface Providers {
  calendar: CalendarProvider;
  mail: MailProvider;
}
