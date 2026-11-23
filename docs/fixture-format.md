# Fixture world format (v2)

Status: written in M2a; v2 (M4a, 2026-11-17) adds the optional `mail` key, and v1 files still load. The fixture world is the fake calendar/mail universe loaded by `src/providers/fixture`. It is a contract: tests, Deskbench scenarios and Deskflow demo seed data all use it. Changing the shape is breaking and bumps `fixture_version`.

## Loading

- JSON only. UTF-8, no comments.
- `DESKHAND_FIXTURE` is the path to the file. Requires `DESKHAND_PROVIDER=fixture` (ADR 0008). Unset (with the provider set to `fixture`) means an empty world (no calendars, clock at the real current time).
- The loader accepts `fixture_version` 1 and 2. It rejects: a missing `fixture_version` or any value other than 1 or 2, unknown top-level keys, unknown keys inside `settings`, duplicate event ids within a calendar, a `mail` key in a version 1 file, and (v2) duplicate message ids within the mailbox. Extra keys are errors so that later additions (per-person rule sets) force a `fixture_version` bump. Adding mail threads was such an addition: v2.

## Shape

```json
{
  "fixture_version": 1,
  "now": "2026-11-10T09:00:00.000Z",
  "calendars": {
    "primary": {
      "events": [
        {
          "id": "evt_standup",
          "title": "Team standup",
          "start": "2026-11-10T09:30:00.000Z",
          "end": "2026-11-10T09:45:00.000Z",
          "attendees": ["ana@example.com", "ben@example.com"],
          "etag": "e1"
        }
      ]
    }
  },
  "settings": {
    "latency_ms": 0,
    "write_log": "writes.jsonl"
  }
}
```

| Key | Type | Required | Meaning |
|---|---|---|---|
| `fixture_version` | number, `1` or `2` | yes | format version; `mail` needs `2` |
| `now` | ISO-8601 UTC instant | yes | where the fake clock starts. The fixture provider and the server's clock (when a fixture is loaded) read this; time does not advance unless a test advances it |
| `calendars` | object, calendar id to `{ events }` | yes (may be `{}`) | calendar ids are free strings; `primary` is the default |
| `calendars.<id>.events[]` | object | yes (may be `[]`) | `id` string unique per calendar; `title` string; `start` and `end` ISO-8601 UTC instants with `start < end` (or dates, see All-day events); `attendees` array of email strings (may be empty); `etag` non-empty string, opaque, changes when the event changes; `all_day` optional boolean; `organizer_self` optional boolean (see Organiser) |
| `settings.latency_ms` | non-negative integer | no, default `0` | artificial delay added to every provider call (for timeout and concurrency tests) |
| `settings.write_log` | string path | no | file the fixture provider appends to on every provider write; relative paths resolve against the fixture file's directory. Absent means no log |

## Mail (v2)

An optional top-level `mail` key holds the mailbox of the account owner. It is only allowed when `fixture_version` is 2. Calendar keys are unchanged. Without `mail`, the world has no mailbox and the mail provider fails with a `ProviderError` (`no mailbox in this world`).

```json
{
  "fixture_version": 2,
  "now": "2026-11-10T09:00:00.000Z",
  "calendars": {},
  "mail": {
    "owner": "me@example.com",
    "threads": [
      {
        "id": "thr_budget",
        "messages": [
          {
            "id": "msg_1",
            "message_id": "<budget-1@example.com>",
            "date": "2026-11-09T14:00:00.000Z",
            "from": { "address": "ana@example.com", "name": "Ana" },
            "reply_to": [],
            "to": [{ "address": "me@example.com" }],
            "cc": [{ "address": "ben@example.com" }],
            "subject": "Q4 budget",
            "body_text": "Can you review the numbers before Friday?",
            "unread": true
          }
        ]
      }
    ]
  }
}
```

| Key | Type | Required | Meaning |
|---|---|---|---|
| `mail.owner` | email string | yes | the account owner's address; what `MailProvider.profile()` returns and the `from` of a draft |
| `mail.threads[]` | object | yes (may be `[]`) | `id` string (unique, matching `^[A-Za-z0-9_-]{1,64}$`), `messages` array with at least one message |
| `messages[].id` | string | yes | unique across the whole mailbox (threads and messages) |
| `messages[].message_id` | string | no | the `Message-ID` header (`<...>`); used for `inReplyTo` and `references` |
| `messages[].date` | ISO-8601 UTC instant | yes | |
| `messages[].from` | `{ address, name? }` | yes | `name` is `""` when absent |
| `messages[].reply_to`, `to`, `cc` | `{ address, name? }[]` | `to` yes; the others no (default `[]`) | |
| `messages[].subject`, `body_text` | string | yes | text only; there is no HTML in the fixture |
| `messages[].unread` | boolean | no, default `false` | |
| `messages[].sent` | boolean | no, default `false` | the owner sent this message (`MailMessage.sentByOwner`). Only this makes a message "mine" for default recipients; a `From` equal to the owner does not. Additive: `fixture_version` is unchanged, but an existing world with owner-authored messages and no `sent: true` now picks a different reply target or refuses with no recipient |
| `messages[].draft` | boolean | no, default `false` | a draft message; kept out of `getThread` and of the "on the thread" set |

Provider behaviour (the fixture `MailProvider`, `src/providers/fixture/mail.ts`):

- `searchThreads(query, limit)`: the query is split on whitespace and every term must match. `from:<x>` matches a substring of the From address or name; `is:unread` matches threads with an unread message; any other term is a case-insensitive substring of subject, body or addresses. A term with a `:` that is none of these is a `ProviderError` with the phrase `query operator not supported by the fixture provider`. Results are newest `lastDate` first, at most `limit`; `snippet` is the first 100 characters of the latest body.
- `getThread(id, maxMessages)`: drops `draft: true` messages, keeps the newest `maxMessages` (`truncated` when it cut), oldest first, and cuts each `bodyText` at 20 000 characters (`bodyTruncated`). An unknown id gives `null`.
- `lookupDraft(messageIdHeader, threadId)` and `createDraft(draft)`: `createDraft` records the draft in the world (`draftId` is `dr_<n>`, `messageId` is `msg_dr_<n>`) and appends one line to the write log. A `createDraft` with a `messageIdHeader` that already exists returns the existing draft and writes nothing, which is how crash recovery is simulated. There is no `cancelled` state for drafts (Gmail cannot report a deleted draft).
- There is no send operation, by design.

## All-day events

An event may carry `"all_day": true`. Its `start` and `end` must then be `YYYY-MM-DD` real dates (so `2026-02-30` is a load error) with `start < end`; `end` is exclusive, as in Google (a one-day event on 12 Nov is `2026-11-12` to `2026-11-13`). No time zone is attached.

```json
{ "id": "evt_offsite", "title": "Offsite", "start": "2026-11-12", "end": "2026-11-13", "attendees": [], "etag": "a1", "all_day": true }
```

- Without the key (or with `false`) the instant rules above apply. A date without `all_day: true`, or an instant with `all_day: true`, or a non-boolean `all_day`, is a load error.
- The key is additive: existing files stay valid and `fixture_version` stays 1.
- For listing and sorting, an all-day event spans `<start>T00:00:00.000Z` to `<end>T00:00:00.000Z`.
- An all-day event does not count as busy in `freeBusy` (fixture-only rule; the Google adapter takes free/busy from Google).
- Provider results carry `allDay: true` and the dates as given; timed events carry `allDay: false`.

## Organiser

World events are on the calendar owner's calendar and, by default, organised by the owner: the provider marks them `organizerSelf: true`, as Google reports `organizer.self` for events you organise. `"organizer_self": false` models an invitation from someone else (Google `organizer.self: false`). The key is additive: existing files stay valid and `fixture_version` stays 1. The apply engine accepts an event under an action's idempotency key only when it is organised by the owner (ledger contract, gate 6), so a world event with the plan's fields under the key simulates a crash after the write (recovered, `applied`), and the same event with `organizer_self: false` ends `failed` ("differs") with no write.

## Listing

`listEvents(calendarId, range, limit)` returns the events that overlap `range` (the same overlap rule as `freeBusy`: `event.start < range.end` and `range.start < event.end`), sorted by start (all-day as above) then by `id`, at most `limit`. `truncated` is true when more events matched than were returned. An unknown calendar gives `{ events: [], truncated: false }`. `addBusy` ranges are not events and are never listed.

## Write log

`write_log` is how tests, Deskbench and the red-team harness observe writes from outside the process. For every provider write (and only writes; reads are not logged) the fixture provider appends exactly one line of JSON, flushed before the write is acknowledged:

```json
{"seq":1,"ts":"2026-11-10T09:00:00.000Z","op":"calendar.createEvent","idempotency_key":"<64 hex>","request":{}}
```

`seq` starts at 1 per process and per file append; `ts` is the fake clock; `op` is the provider method name; `idempotency_key` is the one derived from the action id (see `docs/ledger-contract.md`); `request` is the provider request body, redacted by the ledger preview rules. The `mail.createDraft` write logs one line the same way (`op` is `mail.createDraft`); its `request` goes through the same redaction, so the body appears as `[omitted N chars sha256:<8 hex>]` and never as text. A fixture write with an idempotency key already present in the world is a no-op that returns the existing event (and writes no log line), which is how crash recovery is simulated.

Deleted events: the file format has no cancelled events. The provider's test seam `cancelEvent(calendarId, id)` models a user deleting an event, as Google keeps it as `status: cancelled`: `getEvent`, `listEvents` and `freeBusy` no longer see it, `lookupEvent` reports `cancelled` (not `absent`), and `createEvent` with that id throws the "created and later deleted" `ProviderError` and writes nothing.

## Determinism

The clock is fixed at `now`. Ids generated by the provider for new events are derived from the idempotency key, so replays produce identical results. The id seed for action ids is a test-constructor option, not part of the file format.
