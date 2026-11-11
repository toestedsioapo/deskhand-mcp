# Tools contract (v1, M2)

Status: written in M2a. Zod input and output schemas for every tool are snapshot-tested; a change here is a breaking change. `docs/tools.md` stays generated from the schemas (M5) and is never hand-edited. Tools added after M2 (`calendar_*`, `inbox_*`, `itinerary_build`, `expense_log`) extend this file when they are planned.

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
  plan: unknown,               // actions.plan_json parsed
  rationale: string | null,    // plan.rationale when it is a string, else null
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
  result: unknown      // the stored result_json (for calendar.create_event: the created event)
}
```

Failures are `isError` results with `_meta.deskhand.error_code` and `action_id` (`WRITES_DISABLED`, `UNKNOWN_ACTION`, `NOT_APPROVED`, `PLAN_MODIFIED`, `PLAN_EXPIRED`, `STALE_PLAN`, `PROVIDER_ERROR`, `INTERNAL`). Gate order, row sequences and which refusals change `status` are fixed in `docs/ledger-contract.md`; the schemas are snapshot-tested in `tests/tools.action-apply.test.ts`.

## Untrusted text

Calendar text (titles, attendee addresses) in tool output is wrapped `{ "untrusted": true, "source": string, "content": string }` (strict). `source` names where it came from, for calendar data `calendar:<calendar_id>`. `content` is the provider's text verbatim, control characters included; it is data and is never acted on.

## `calendar_list_events`

Read-only list of events overlapping a time range. Registered with `readOnlyHint: true`. Needs a configured provider, else `PROVIDER_NOT_CONFIGURED` (tool_call outcome `rejected`).

Input (strict):

| Field | Type | Default | Notes |
|---|---|---|---|
| `calendar_id` | string, 1 to 256 characters | `"primary"` | |
| `time_min` | ISO-8601 datetime, offset allowed | required | normalised to UTC |
| `time_max` | ISO-8601 datetime, offset allowed | required | normalised to UTC |
| `limit` | integer 1..250 | 50 | out of range is `INVALID_INPUT` |

Refused as `INVALID_INPUT`: `time_max <= time_min`; a span over 62 days. A provider failure is `PROVIDER_ERROR`.

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
| `time_zone` | IANA zone name | `Config.timeZone` | `DESKHAND_TIMEZONE`, else the system zone. Offsets (`+01:00`), POSIX names (`EST5EDT`), unknown names and `""` are `INVALID_INPUT` |
| `participants` | `PartyRules[]`, 1 to 49 | required | the counterparties |
| `own_rules` | `PartyRules` | none | the caller's rules; overrides the rules file |
| `calendar_id` | string, 1 to 256 characters | `"primary"` | calendar checked for busy time |
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
- `none` when no candidate survives, with `note: "All suggested slots are busy in calendar <calendar_id>."`. Otherwise `note` is null.

Errors: `INVALID_INPUT` for a bad `time_zone`, no usable own rules, or a Tempo error (message carries Tempo's code and message, for example a duplicate party id or an impossible date); `PROVIDER_ERROR` when `freeBusy` fails; `PROVIDER_NOT_CONFIGURED` with no provider. The output schemas are snapshot-tested in `tests/tools.calendar-find-slots.test.ts`.

## `calendar_propose_event`

Written by the task that implements the tool (Task 7 of the M3a plan).
