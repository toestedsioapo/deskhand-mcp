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
  diff: string[] | null,       // lines from the deterministic plan renderer (never agent text); an unrenderable stored plan yields `(unknown plan kind)` or `(invalid plan)`. The schema stays nullable (a contract from M2a) but the handler always returns an array
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
