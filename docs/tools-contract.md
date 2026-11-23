# Tools contract (v1, M2)

Status: written in M2a. Zod input and output schemas for every tool are snapshot-tested; a change here is a breaking change. `docs/tools.md` stays generated from the schemas (M5) and is never hand-edited. Tools added after M2 (`calendar_*` in M3a, `inbox_*` in M4a, `itinerary_build`, `expense_log`) extend this file when they are planned.

## Result convention

- Success: `structuredContent` is the tool's output object (validated against the output schema); `content` carries the same object as a single JSON text block. A result that concerns an action also sets `_meta.deskhand.action_id` (`toolOk(output, { action_id })`); that is the only place the `tool_call` row's `action_id` is read from.
- Failure: `isError: true`, **no `structuredContent`**, `content` is one text block `"<ERROR_CODE>: <message>"`, and `_meta.deskhand` is `{ "error_code": <error_code>, "action_id"?: <string> }` (`toolError(code, message, { action_id })`). `error_code` is one of the values in `docs/ledger-contract.md`. `action_id` is present when the failure concerns an action. Reason: the SDK 1.32.2 client validates `structuredContent` against the tool's output schema even on `isError` results, so an error object there makes `callTool` throw for any tool with an output schema.
- The ledger transport reads `error_code` and `action_id` only from `_meta.deskhand`, strictly validated (a known code; `action_id` a string naming an existing action, else NULL). It never reads them from `structuredContent`, so untrusted content cannot spoof a code. Results carrying `_meta.deskhand` are classified from it alone; an `isError` result with an invalid `_meta.deskhand` is logged `INTERNAL`. Results without `_meta.deskhand` are classified only by the exact SDK-built text prefixes below, yielding `INVALID_INPUT` or `UNKNOWN_TOOL`, else `INTERNAL`.
- Failures raised by the SDK itself (SDK 1.32.2) are `isError` results, not JSON-RPC errors, with no `_meta.deskhand`: invalid arguments give text `MCP error -32602: Input validation error: Invalid arguments for tool <name>: ...` (logged `INVALID_INPUT`), an unknown tool gives `MCP error -32602: Tool <name> not found` (logged `UNKNOWN_TOOL`), and a thrown handler error or an output-schema mismatch gives the error text (logged `INTERNAL`). Malformed `tools/call` params (no `name`, non-object `arguments`) are a JSON-RPC error `-32603` (logged `INTERNAL`); a JSON-RPC `-32602` would be logged `INVALID_INPUT`.
- Every `tools/call` writes exactly one `tool_call` event; see the ledger contract for the `outcome` mapping. Error rows store `preview.output = null` and the redacted error message in `preview.note`. A successful `action_explain` result sets `_meta.deskhand.action_id`, so its `tool_call` row carries that `action_id` and explains appear in the action's own history. `events.tool` is stored capped at 200 characters (the response path is unchanged).
- Text that originates in mailbox or calendar content is wrapped `{ "untrusted": true, "source": <string>, "content": <string> }`. Stored previews and plans are returned as data, never acted on.
- Read tools are registered with `readOnlyHint: true`.

## `EventRow` (shared output type)

```
{
  id: integer,                 // events.id, append order
  ts: string,                  // ISO-8601 UTC with ms and Z
  action_id: string | null,
  tool: string,
  kind: one of event_kinds,
  outcome: one of event_outcomes,
  error_code: one of error_codes | null,
  preview: { v: 1, input: unknown, output: unknown | null, note: string | null }
}
```

`preview` is `events.preview_json` parsed; it is the stored, already-redacted preview and is returned unchanged.

## `ping`

Unchanged from M1. Input `{}` (strict). Output `{ ok: true, server: "deskhand-mcp", version: string }`. Description: "Health check. Returns the server name and version. Read-only: has no side effects." The JSON Schema in `tests/__snapshots__/ping.test.ts.snap` is the reference; it must not change in M2.

## `ledger_query`

Read-only query over `events`, newest first.

Input (strict):

| Field | Type | Default | Notes |
|---|---|---|---|
| `limit` | integer 1..200 | 50 | out of range is `INVALID_INPUT` |
| `kind` | one of `event_kinds` | none | filter |
| `outcome` | one of `event_outcomes` | none | filter |
| `tool` | string | none | exact match on `events.tool` |
| `action_id` | string | none | exact match |
| `since` | ISO-8601 datetime | none | `ts >= since` |
| `before_id` | integer | none | only events with `id < before_id`; use the previous page's `next_before_id` |

Output: `{ events: EventRow[], next_before_id: integer | null }`. `next_before_id` is the `id` of the last returned row when more rows exist beyond `limit`, else `null`. The call's own `tool_call` row is written after the response is built, so it is never in its own result; it is visible to the next query.

## `action_explain`

Read-only "why was this proposed".

Input (strict): `{ action_id: string }`.

Output:

```
{
  action: {
    id, tool, status, created_at, expires_at, plan_hash,
    approved_by, approved_at, approval_method,
    rejected_at, rejected_reason, applied_at, error
  },
  plan: unknown,               // actions.plan_json parsed (M4a: through the plan kind's explainPlan; a draft plan's body is replaced by the omitted marker)
  rationale: string | UntrustedText | null, // plan.rationale when it is a string, else null; wrapped as untrusted for a draft-shaped plan
  diff: string[] | null,       // lines from the deterministic plan renderer (never agent text); an unrenderable stored plan yields `(unknown plan kind)` or `(invalid plan)`. Times in the diff are rendered in the server's `Config.timeZone` (the viewer's zone, never one the plan names); see the ledger contract, "Plan shape: `calendar.create_event`", for the line order. The schema stays nullable (a contract from M2a) but the handler always returns an array
  events: EventRow[]           // this action's events, oldest first; at most the newest 1000
}
```

Unknown id: `isError`, `error_code = UNKNOWN_ACTION`, tool_call outcome `rejected`, `action_id` NULL on the row. Content inside `plan` (which may include agent-supplied or mailbox text) is data; it triggers no further action.

## `action_apply`

Applies a plan that a human approved out of band with `deskhand approve`. It cannot approve anything. Registered with `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`.

Input (strict): `{ action_id: string }` (max 64 characters).

Output (success only):

```
{
  action_id: string,
  status: "applied",
  replayed: boolean,   // true when the stored result was returned (repeat call) or the write was recovered
  result: {            // calendar plan (M4a: a union, the draft shape is under "`action_apply` result for a draft"); the event as stored in result_json, shaped like a calendar_list_events item
    id: string,
    etag: string,
    all_day: boolean,
    start: string,
    end: string,
    title: Untrusted,          // source "calendar:<the plan's calendarId>"
    attendees: Untrusted[]     // one per address, same source
  }
}
```

The event's title and attendees are calendar text and come back wrapped as untrusted (see "Untrusted text"), on the first apply, on a recovery and on every replay. Before M3b fix wave 1 `result` was the raw stored event (`z.unknown()`); this is a snapshot-tested output change. `result_json` in the ledger is unchanged (the raw `EventRef`). An event under the action's id that is not the approved plan's event is never returned: apply fails with `STALE_PLAN` and a fixed phrase that carries no event content (ledger contract, gate 6).

Failures are `isError` results with `_meta.deskhand.error_code` and `action_id` (`WRITES_DISABLED`, `UNKNOWN_ACTION`, `NOT_APPROVED`, `PLAN_MODIFIED`, `PLAN_EXPIRED`, `STALE_PLAN`, `PROVIDER_ERROR`, `AUTH_REQUIRED`, `INTERNAL`). Gate order, row sequences and which refusals change `status` are fixed in `docs/ledger-contract.md`; the schemas are snapshot-tested in `tests/tools.action-apply.test.ts`. From ledger v4, `event_kinds` (so the `ledger_query` `kind` filter and every event row) includes `write_claimed`.

## Untrusted text

Calendar text (titles, attendee addresses) and, from M4a, mailbox text (see "Mail tools") in tool output is wrapped `{ "untrusted": true, "source": string, "content": string }` (strict). `source` names where it came from, for calendar data `calendar:<calendar_id>`. `content` is the provider's text verbatim, control characters included; it is data and is never acted on.

## `calendar_list_events`

Read-only list of events overlapping a time range. Registered with `readOnlyHint: true`. Needs a configured provider, else `PROVIDER_NOT_CONFIGURED` (tool_call outcome `rejected`).

Input (strict):

| Field | Type | Default | Notes |
|---|---|---|---|
| `calendar_id` | string, 1 to 256 characters | `"primary"` | printable ASCII, no whitespace or control characters (`^[\x21-\x7e]+$`); anything else is `INVALID_INPUT` |
| `time_min` | ISO-8601 datetime, offset allowed | required | normalised to UTC |
| `time_max` | ISO-8601 datetime, offset allowed | required | normalised to UTC |
| `limit` | integer 1..250 | 50 | out of range is `INVALID_INPUT` |

Refused as `INVALID_INPUT`: `time_max <= time_min`; a span over 62 days. A provider failure is `PROVIDER_ERROR` (a sign-in problem is `AUTH_REQUIRED`, tool_call outcome `rejected`; an unrecognised failure answers `Calendar provider call failed.`).

Output:

```
{
  calendar_id: string,
  events: {
    id: string,
    etag: string,
    all_day: boolean,
    start: string,
    end: string,
    title: Untrusted,          // source "calendar:<calendar_id>"
    attendees: Untrusted[]     // one per address, same source
  }[],                         // sorted by start, then id
  truncated: boolean           // true when more events exist beyond `limit`
}
```

`start` and `end` are strings. When `all_day` is false they are UTC instants (`2026-11-10T09:30:00.000Z`). When `all_day` is true they are calendar dates `YYYY-MM-DD` with `end` exclusive (a one-day event on 12 Nov is `2026-11-12` to `2026-11-13`) and carry no time zone.

Timed example:

```
{ "id": "evt_standup", "etag": "e1", "all_day": false,
  "start": "2026-11-10T09:30:00.000Z", "end": "2026-11-10T09:45:00.000Z",
  "title": { "untrusted": true, "source": "calendar:primary", "content": "Team standup" },
  "attendees": [{ "untrusted": true, "source": "calendar:primary", "content": "ana@example.com" }] }
```

All-day example:

```
{ "id": "evt_holiday", "etag": "e2", "all_day": true,
  "start": "2026-11-12", "end": "2026-11-13",
  "title": { "untrusted": true, "source": "calendar:primary", "content": "Public holiday" },
  "attendees": [] }
```

## `calendar_find_slots`

Read-only search for meeting slots that fit everyone's working-hours rules and are free in the caller's calendar. Registered with `readOnlyHint: true`. Needs a configured provider, else `PROVIDER_NOT_CONFIGURED` (tool_call outcome `rejected`). It writes no plan row and nothing to the provider: its only ledger rows are the usual `tool_call` row.

Tempo (`src/tempo/`) decides which slots fit the working-hours rules; this tool then drops the ones that are busy in the calendar (`provider.freeBusy`, one call spanning the earliest candidate start to the latest candidate end). All-day events are not busy time for this purpose.

Input (strict):

| Field | Type | Default | Notes |
|---|---|---|---|
| `date` | `YYYY-MM-DD` | required | local date of the requested slot in `time_zone`; a date that is not on the calendar is `INVALID_INPUT` (Tempo rejects it) |
| `start` | `HH:mm` | required | local start, 00:00 to 23:59 |
| `end` | `HH:mm` | required | local end |
| `time_zone` | IANA zone name | `Config.timeZone` | `DESKHAND_TIMEZONE`, else the system zone. The name is used in its canonical spelling (`europe/berlin` is `Europe/Berlin`; aliases such as `Asia/Calcutta` are kept, only their case is fixed). Offsets (`+01:00`), POSIX names (`EST5EDT`), unknown names and `""` are `INVALID_INPUT` |
| `participants` | `PartyRules[]`, 1 to 49 | required | the counterparties |
| `own_rules` | `PartyRules` | none | the caller's rules; overrides the rules file |
| `calendar_id` | string, 1 to 256 characters | `"primary"` | calendar checked for busy time; printable ASCII, no whitespace or control characters (`^[\x21-\x7e]+$`); anything else is `INVALID_INPUT` |
| `max_suggestions` | integer 1..10 | 3 | most slots returned |
| `min_notice_minutes` | integer 0..525600 | 0 | |
| `search_horizon_days` | integer 1..90 | 14 | how far Tempo looks for alternatives |

`PartyRules` (strict): `{ partyId: string 1..64, timeZone: string, weeklyRules: { monday..sunday: { start: "HH:mm", end: "HH:mm" or "24:00" }[] (each day optional) }, blackouts: "YYYY-MM-DD"[] (default []) }`. Party ids must be unique across `own_rules` (or the rules file) and `participants`.

The caller's rules are `own_rules` if given, else the JSON file at `Config.rulesPath` (`DESKHAND_RULES`, else `<config dir>/rules.json`), read and validated on every call. A missing, unparsable or schema-invalid file is `INVALID_INPUT` naming the path and the `own_rules` field; the server keeps running.

Output:

```
{
  decision: "book" | "counter_offer" | "none",
  requested: Slot,
  slots: Slot[],               // at most max_suggestions, best first
  busy_dropped: integer,       // candidates dropped because the calendar is busy
  reasons: { code: string, participant_id: string | null, message: string }[],   // Tempo's, verbatim
  note: string | null
}
Slot = { start, end, startUtc, endUtc }   // start/end local ISO in time_zone, startUtc/endUtc the same instants in UTC
```

Behaviour: Tempo is asked for 10 suggestions with `now` set to the server clock. The candidates are Tempo's `slots` in every case (on a Tempo `book`, `slots[0]` is the requested slot and the rest are ranked alternatives). A candidate overlapping any busy block is dropped.

- Tempo said `book` and the requested slot is free: `decision: "book"`, `slots` is the requested slot alone, `busy_dropped: 0`.
- Tempo said `book` but the requested slot is busy: it is dropped and counted in `busy_dropped`; the surviving alternatives (first `max_suggestions`) give `counter_offer`.
- Tempo said `counter_offer`: busy candidates are dropped, `slots` is the first `max_suggestions` survivors, `reasons` carries Tempo's reasons (for example `OUTSIDE_AVAILABILITY` with the `participant_id`).
- `none` when no candidate survives. If Tempo returned no candidate at all, `note: "No slot fits the given rules."`, `busy_dropped: 0` and Tempo's `reasons` are passed through. If there were candidates and every one was dropped as busy, `note: "All suggested slots are busy in calendar <calendar_id>."`. Otherwise `note` is null.

Errors: `INVALID_INPUT` for a bad `time_zone`, no usable own rules, or a Tempo error (message carries Tempo's code and message, for example a duplicate party id or an impossible date); `PROVIDER_ERROR` when `freeBusy` fails (`AUTH_REQUIRED` when sign-in is needed); `PROVIDER_NOT_CONFIGURED` with no provider. The output schemas are snapshot-tested in `tests/tools.calendar-find-slots.test.ts`.

## `calendar_propose_event`

Plans a new calendar event. It writes a plan row (`actions` status `planned`) in the ledger and nothing in the calendar: it never calls a provider write. A human must read the diff and approve with `deskhand approve <action_id>` (out of band, never an MCP tool); only then can `action_apply` create the event. Registered with `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false` (each call creates a new plan). Needs a configured provider, else `PROVIDER_NOT_CONFIGURED` (tool_call outcome `rejected`).

Input (strict):

| Field | Type | Default | Notes |
|---|---|---|---|
| `title` | string, 1 to 200 characters | required | one line of visible text: no control, format, bidirectional, zero-width or blank filler characters, no line breaks or tabs, single ASCII spaces between words only and none at either end; anything else is `INVALID_INPUT`. Stored verbatim and shown verbatim in the diff, so the approver reads exactly what is written. Letters of any script are accepted; an emoji that needs a variation selector or a zero-width joiner is not |
| `start` | ISO-8601 datetime, offset allowed | required | stored as UTC with milliseconds and `Z`; must be after the server clock |
| `end` | ISO-8601 datetime, offset allowed | required | stored as UTC; must be after `start` |
| `attendees` | email[], at most 50, each at most 254 characters | `[]` | the diff never truncates an address |
| `send_updates` | `"none"` \| `"all"` \| `"externalOnly"` | `"none"` | whether attendees are emailed when the event is created |
| `calendar_id` | string, 1 to 256 characters | `"primary"` | printable ASCII, no whitespace or control characters (`^[\x21-\x7e]+$`); anything else is `INVALID_INPUT` |
| `time_zone` | IANA zone name | `Config.timeZone` | the event's own zone, always stored in the plan as `event.timeZone` (resolved at plan time: this input, else `Config.timeZone`, always in its canonical spelling, so `europe/berlin` and `Europe/Berlin` give the same plan hash) and shown on an `event zone:` diff line when it differs from the viewer's `Config.timeZone` (compared in canonical spelling). Offsets (`+01:00`), POSIX names and unknown names are `INVALID_INPUT` |
| `rationale` | string, at most 500 characters | none | why the agent proposes it; stored in the plan |

Output:

```
{
  action_id: string,
  plan_hash: string,       // 64 hex characters
  expires_at: string,      // ISO-8601 UTC, plan creation time + Config.planTtlHours
  diff: string[],          // what the approver will read, in Config.timeZone
  next_step: string        // exactly "A human must run: deskhand approve <action_id>"
}
```

The result sets `_meta.deskhand.action_id`, so the `tool_call` row carries the action id. Ledger rows on success: `plan_created`, then `tool_call`, both with the action id.

Refused as `INVALID_INPUT` (no plan row): `end <= start`; `start` not after the server clock; a `time_zone` that is not an IANA name; a `calendar_id` with whitespace or control characters; a `title` that is not one line of visible text; an unknown extra field; a slot that overlaps a busy block in the calendar (`The slot is busy in calendar <id>; use calendar_find_slots.`, checked with `provider.freeBusy`; all-day events are not busy time). A provider failure while checking is `PROVIDER_ERROR` (`AUTH_REQUIRED` when sign-in is needed).

The plan it stores (`plan_json`, hashed with the canonical JSON):

```
{ kind: "calendar.create_event", rationale?,
  event: { title, start, end, attendees, sendUpdates, calendarId, timeZone },
  observed: { slotFree: true, etags: {} } }
```

`timeZone` is part of the plan hash (two plans differing only in zone have different hashes); the viewer zone is not. `action_apply` re-checks that the slot is still free and, if not, fails with `STALE_PLAN` without writing.

Diff lines, in order: `create event: <title>`, `when: <range in Config.timeZone>`, `event zone: <range in the event zone>` (only when it differs), `utc: <start> to <end>`, `calendar: <id>`, `<N> attendees`, one `  <address>` line per attendee, then the notification line: `no attendee notifications (sendUpdates=none)`; `will email <n> attendees` (`all`); `will email the attendees outside your organisation, up to <n> (sendUpdates=externalOnly)`; or, for `all` / `externalOnly` with no attendees, `no attendee notifications (sendUpdates=<value>, no attendees)`. Title, calendar id and addresses are printed verbatim (the input rules above are what make that safe).

The output schemas are snapshot-tested in `tests/tools.calendar-propose-event.test.ts`.

## Mail tools (M4a)

All four need a configured provider, else `PROVIDER_NOT_CONFIGURED` (tool_call outcome `rejected`). M4a runs them on the fixture mailbox (`fixture_version: 2`); the Gmail adapter comes in M4b. An unknown `thread_id` is `NOT_FOUND` with the message `No thread with id <id>.` (tool_call outcome `error`). A provider failure is `PROVIDER_ERROR` (`AUTH_REQUIRED` when sign-in is needed). Every call, including a `NOT_FOUND` and a validation failure, writes its `tool_call` row.

**Untrusted mail text.** All mailbox text in a result is wrapped `{ "untrusted": true, "source": string, "content": string }`: subjects, snippets, bodies, and sender and recipient addresses and display names. The `source` is `mail:<thread_id>`, or `mail:search` for search results. Thread ids, message ids, dates, counts and booleans are not wrapped. Ledger previews of these results contain no subject, snippet or body in clear: the wrapper's `content` and the keys `snippet` and `body_text` are omitted by the redactor (`BODY_KEY`, see the ledger contract).

`threadIdSchema` is `^[A-Za-z0-9_-]{1,64}$`. In the output shapes below, `Addr` is `{ address: Untrusted, name: Untrusted }`.

### `inbox_search`

Read-only search of the mailbox. Registered with `readOnlyHint: true`.

Input (strict): `{ query: string 1..500 characters with no control or hidden characters, limit: integer 1..25 = 10 }`. The fixture provider splits the query on whitespace and every term must match: `from:<x>` (a substring of the From address or name), `is:unread`, or any other term as a case-insensitive substring of subject, body or addresses. Any other `<operator>:<value>` term is `PROVIDER_ERROR` with the phrase `query operator not supported by the fixture provider`.

Output:

```
{
  threads: {
    id: string,
    subject: Untrusted,
    from: Addr | null,
    last_date: string,         // ISO-8601 UTC instant of the newest message
    snippet: Untrusted,        // first 100 characters of the latest body
    message_count: integer,
    unread: boolean
  }[],                         // newest last_date first, at most `limit`; source "mail:search"
  truncated: boolean           // true when more threads matched than `limit`
}
```

### `inbox_read_thread`

Read-only. Registered with `readOnlyHint: true`.

Input (strict): `{ thread_id: string }`.

Output:

```
{
  thread_id: string,
  truncated: boolean,          // true when the thread has more than the newest 100 messages
  messages: {                  // oldest first, drafts excluded
    id: string, date: string,
    from: Addr | null, reply_to: Addr[], to: Addr[], cc: Addr[],
    subject: Untrusted,
    body_text: Untrusted,      // cut at 20 000 characters
    body_truncated: boolean,
    unread: boolean
  }[]                          // source "mail:<thread_id>"
}
```

At most the newest 100 messages are returned. The ledger preview of a long thread stays under the 4 KB cap and holds no body text.

### `inbox_triage`

Proposes only (SPEC D12). It validates and records the agent's proposals; Deskhand never applies a label, a priority or a move. It writes one `tool_call` row and no `actions` row, so nothing can approve or apply it, and `action_apply` on its id is `UNKNOWN_ACTION`. Registered with `readOnlyHint: true`.

Input (strict):

```
{ proposals: {                  // 1 to 25, thread ids unique (a repeat is INVALID_INPUT)
    thread_id: string,
    priority: "high" | "normal" | "low",
    next_action: "reply" | "schedule" | "delegate" | "read_later" | "archive" | "none",
    labels: string[],           // at most 5, each a plain line (isPlainLine) of at most 40 characters; default []
    reason?: string             // at most 300 characters
  }[] }
```

Output:

```
{
  proposals: { thread_id, subject: Untrusted, priority, next_action, labels, reason: string | null }[],
  applied: false,
  note: "Proposals only. Deskhand never applies labels or moves mail."
}
```

The first unknown thread gives `NOT_FOUND` and nothing is returned for the other proposals. The subject is the thread's (source `mail:<thread_id>`).

### `inbox_draft_reply`

Plans a draft reply. It writes a plan row (`actions` status `planned`) and nothing in the mailbox: it never calls `createDraft`. A human must read the diff and approve with `deskhand approve <action_id>`; only then can `action_apply` create the draft. There is no way to send mail: the provider interface has no send method (ADR 0001, ADR 0007). Registered with `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`.

Input (strict):

| Field | Type | Default | Notes |
|---|---|---|---|
| `thread_id` | string | required | unknown is `NOT_FOUND` |
| `body` | string, 1 to 20 000 characters | required | `\r\n` becomes `\n`; a lone `\r`, a tab, a trailing space (except the exact line `-- `), a hidden character, a run of more than 16 whitespace characters, more than 16 consecutive empty lines, more than 500 lines or more than 20 000 characters is `INVALID_INPUT`; see the ledger contract, "Plan shape: `mail.create_draft_reply`" |
| `subject` | string, 1 to 250 characters | `Re: <latest subject>` (not doubled if it already starts with `Re:`, any case) | one plain line (`isPlainLine`). If the thread's subject is not a plain line and no `subject` is given, `INVALID_INPUT` tells the agent to pass `subject` explicitly. A given subject is checked on its own |
| `to` | email[] | see below | |
| `cc` | email[] | `[]` | |
| `bcc` | email[] | `[]` | |
| `reply_all` | boolean | `false` | only used when `to` is omitted |
| `rationale` | one plain line, 1 to 500 characters (the subject's rule) | none | shown to the approver as `agent's reason: <text>`; removed from the plan by the body sweep |

Default recipients (only when `to` is omitted): the reply goes to the latest non-draft message that was not sent by the owner, to that message's Reply-To, else its From; `reply_all: true` adds that message's To (to `to`) and Cc (to `cc`), minus the owner and minus duplicates. If every message is from the owner, the default is the latest message's To (nothing is addressed to the owner), and `reply_all: true` adds that message's Cc to `cc`. A `cc` or `bcc` given without `to` is kept alongside the defaults. A default recipient that breaks the address rule, or no default recipient at all, is `INVALID_INPUT` asking for `to` explicitly. In-Reply-To is the latest message's Message-ID and References the thread's last 10 Message-IDs (of the newest 100 messages), keeping only `<...>` shaped printable-ASCII values. If `to` is given, `cc` and `bcc` default to `[]` and nothing is added. Every address must be `z.email()`, at most 254 characters, printable ASCII (an address such as `josé@example.com` is refused, naming the rule); at least one `to`, at most 50 recipients in total, none repeated across to, cc and bcc. "On the thread" means a From, To or Cc of a non-draft message, or the owner. An address seen only in a Reply-To is not on the thread, so a default reply to it is flagged as new (owner decision, 2026-11-23).

Output:

```
{
  action_id: string,
  plan_hash: string,           // 64 hex characters
  expires_at: string,
  diff: string[],              // the agent audience: body rows replaced by "  [omitted <c> chars sha256:<8 hex>]",
                               // the thread id, message id, subject, agent's reason and every address value
                               // replaced by its omitted marker
  new_recipients: UntrustedText[], // recipients not on the thread, lowercased, each wrapped with source
                               // "mail:<thread_id>" (one can come from a Reply-To header); [] when none
  body: string                 // the omitted marker, never the text
}
```

The result sets `_meta.deskhand.action_id`. Ledger rows on success: `plan_created`, then `tool_call`, both with the action id. `actions.input_json` holds omitted markers for `body`, `rationale`, `to`, `cc` and `bcc`. No plan row is written for a refusal. Which recipients count as "on the thread": every address in the From, To and Cc of each non-draft message, plus the owner (Reply-To does not count), compared case-insensitively; only addresses that pass the address rule count. This set is computed from the provider (the newest 100 messages); the recipients in it are stored, lowercased and sorted, as `observed.onThread` (decision 5: only the recipients, so the plan holds no other thread address), covered by the plan hash. Any other recipient is flagged `(new: not on this thread)` in the diff and listed in `new_recipients`. New recipients are flagged, not refused.

The plan it stores is `mail.create_draft_reply` (ledger contract). The diff lines are in the ledger contract, "Plan shape: `mail.create_draft_reply`". The output schemas are snapshot-tested in `tests/tools.inbox-draft-reply.test.ts`.

## `action_apply` result for a draft (M4a)

The `result` of a successful `action_apply` is now a union: the calendar shape above, or, for a `mail.create_draft_reply` plan, the draft shape. `status`, `replayed` and `action_id` are unchanged. The calendar branch is unchanged, so this is additive for calendar callers.

```
result (draft) = {
  draft_id: string, message_id: string, thread_id: string,
  subject: Untrusted, to: Untrusted[], cc: Untrusted[], bcc: Untrusted[],   // source "mail:<thread_id>"
  body: string                  // the omitted marker, never the text
}
```

The shape is built from `result_json` (the `DraftRef` and `bodySha256`) on the first apply, on a recovery and on every replay, so it never contains the body. Gate order and failures are in the ledger contract ("Gates 6 to 9 for a `mail.create_draft_reply` plan"). The `STALE_PLAN` messages are exactly `The world changed since planning: the mailbox account changed since planning.`, `The world changed since planning: the thread no longer exists.`, `The world changed since planning: the thread has a new message since planning.`, `The world changed since planning: the thread's messages changed since planning.`, `The world changed since planning: the plan has no record of the thread's messages.` (gate 8, the prefix every kind's re-check failure carries) and `a draft with this action's id exists but differs from the approved plan` (gates 6 and 9, no prefix). While another apply of the same action may be writing, `action_apply` answers `PROVIDER_ERROR` with `another apply of this action is in progress or may still be landing; retry in a minute` and writes nothing (ledger contract, gate 8b); retry after a minute.

## `action_explain` for a draft (M4a)

`plan` is `kind.explainPlan(plan)`: for a draft plan it is the stored plan with `draft.body` replaced by the omitted marker `[omitted <c> chars sha256:<8 hex>]` (a swept plan has `bodyRemoved: true` and no `body`), and `rationale`, `draft.threadId`, `draft.inReplyTo`, every `draft.references` entry, `draft.subject`, `draft.from`, every `draft.to` / `draft.cc` / `draft.bcc` entry, `observed.latestMessageId` and every `observed.onThread` entry wrapped as untrusted mail text, `{ untrusted: true, source: "mail:<threadId>", content }`, key order kept; `observed.messageIdsSha256` is a hash and stays as stored for a valid plan. A draft-shaped plan that is invalid is wrapped too, with the fixed source `mail:invalid-plan`: every stored string, unknown keys collected in one wrapped `unrecognised` text, and any `body` only ever an omitted marker. `diff` is rendered for the agent audience (body rows replaced by one omitted row; thread id, message id, subject, agent's reason and addresses by their omitted markers). The thread subject appears in clear nowhere in the output outside an untrusted wrapper's `content`. The body text appears nowhere in the output, in its `tool_call` preview or in `ledger_query` output. For a calendar plan `plan` is the stored plan, as before.
