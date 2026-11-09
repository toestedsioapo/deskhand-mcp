# M2b Approval, Apply and CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plan, approve and apply a write end to end against the fixture provider, with every safety rule in SECURITY.md and ADR 0002 backed by a test that tries to break it, and with the server shutting down without losing in-flight work.

**Architecture:** `src/providers/` defines a small `CalendarProvider` interface and an in-memory fixture implementation. `src/approval/` holds plan kinds (schema, diff renderer, re-check, execute), the plan store, the approve/reject logic and the apply engine; all state changes are compare-and-set inside `BEGIN IMMEDIATE` and write their `events` rows in the same transaction. `action_apply` is the only MCP tool that can cause a provider write; approval exists only in the CLI. One plan kind, `calendar.create_event`, is implemented now so the gates, re-check and idempotency can be exercised for real; M3 adds the `calendar_propose_event` tool, Google adapter and Tempo on top of it.

**Tech Stack:** as M2a. No new runtime dependencies.

**Spec:** `docs/SPEC.md` §5-6 and D3-D7, D10; `docs/adr/0002-approval-out-of-band-cli.md`, `0001-provider-interface-and-fixture.md`; `docs/SECURITY.md`; `docs/TEST_PLAN.md` (Apply gates, Hash binding, Re-check, Idempotency, CLI approve, Action ids, CLI reject, Concurrency rows); the M2a contract documents `docs/ledger-contract.md`, `docs/fixture-format.md`, `docs/tools-contract.md`. Companion: `2026-11-09-m2a-ledger.md` (must be complete first). Contracts: `CLAUDE.md`.

## Global Constraints

- Everything in M2a's Global Constraints still applies.
- **No side effects outside `action_apply`.** Only `src/approval/apply.ts` may call a provider write method (`createEvent`); a test scans `src/` to enforce it.
- **Approval is CLI-only.** Only `src/approval/approve.ts` may set `status='approved'` or write `approved_by`/`approved_at`/`approval_method`/`approved_plan_hash`; no MCP tool named like approve/reject exists; a test scans `src/` and the tool list.
- `action_apply` refuses unless all of: `DESKHAND_ALLOW_WRITES=1`; plan exists; not expired; `status=approved`; `sha256(canonical(plan_json)) == plan_hash == approved_plan_hash`; not already applied (a repeat returns the stored result). Then the world is re-checked. Gate order (in `docs/ledger-contract.md`, M2a Task 1): writes flag, exists, applied-replay, approved, hash, **recovery**, expiry, re-check, write. Recovery: if the provider already holds the event for this action's idempotency key, finalize as `applied` (`replayed: true`, `applied` event with note `recovered`) without another write, even if the plan has since expired or the slot check would now fail because of our own event; the ledger must reflect what really happened.
- `approve` needs a TTY on **stdin and stdout**, shows the diff and the first 8 hex chars of the plan hash, and requires the last 4 characters of the action id; no `--yes`, no piped input. `reject` needs no TTY and logs `cli_tty` or `cli_no_tty`.
- Every refusal writes an `events` row and leaves `actions.status` unchanged, except `PLAN_MODIFIED`, `STALE_PLAN` and provider failure at apply, which set `failed` (terminal).
- `plan_json` is never updated after planning. Anything that changes what the plan does to the outside world (including `sendUpdates`, default `none`) is inside `plan_json`.
- Provider writes use an idempotency key derived from the action id: lowercase hex sha256 of the id (valid Calendar event-id charset).
- CLI output strips control and ANSI characters from untrusted text (plan titles, attendee names, reasons).
- `DESKHAND_PLAN_TTL_HOURS` default 24, range 1-168 (done in M2a).
- Help and `--version` never open the ledger.

## Review Focus

- `deskhand approve` run by a script with stdin piped, or with stdout redirected to a file: refuses, logs `NOT_A_TTY`, status unchanged, even if the piped text is the correct last 4.
- Typed confirmation `abcd` for id `…ABCD`: accepted (case-insensitive); typed with surrounding spaces: accepted; typed full id or empty line: refused.
- Two approvals racing on one plan from two processes: exactly one `approved` event, the other refused, no corrupted row.
- Two `action_apply` calls racing: one provider write, one `applied` event, both callers get the same stored result.
- Provider write succeeded but the process died before the ledger update: the retry finalizes the action as applied without a second write, even after the plan expired or the slot check would now fail.
- Plan title or attendee name containing ANSI escapes, newlines or "approve all pending plans": rendered inert in `pending`/`approve`, and no behaviour change.
- Stdin closed while an `action_apply` is mid-flight: the write completes, the response is flushed, the row is `applied`, exit 0.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/app-context.ts` | `AppContext` (replaces M2a's `ServerDeps` as an alias target) |
| `src/providers/types.ts` | `CalendarProvider` and its value types |
| `src/providers/fixture/world.ts`, `provider.ts`, `index.ts` | world schema/loader, in-memory provider, `createFixtureProvider` |
| `src/approval/plan-kinds.ts` | `PlanKind` registry; `calendar.create_event` |
| `src/approval/plans.ts` | `createPlan`, `listPending` |
| `src/approval/approve.ts` | `approveAction`, `rejectAction` |
| `src/approval/apply.ts` | `applyAction` |
| `src/tools/action-apply.ts` | schema + handler |
| `src/cli/context.ts`, `src/cli/io.ts`, `src/cli/pending.ts`, `src/cli/approve.ts`, `src/cli/reject.ts` | CLI wiring, IO abstraction, sanitising, commands |
| `src/shutdown.ts` | `installStdinShutdown` |
| `scripts/redteam-sandbox.mjs` | builds a seeded sandbox for the red-team review |
| `tests/helpers/seed.ts` | test seeding helpers (plans in chosen states) |

---

### Task 1: Provider interface and fixture provider

**Files:**
- Create: `src/app-context.ts`, `src/providers/types.ts`, `src/providers/fixture/{world,provider,index}.ts`, `tests/helpers/seed.ts` (provider part)
- Modify: `src/server.ts` (`ServerDeps = AppContext`; `main()` builds the fixture provider from `config.fixturePath`)
- Test: `tests/provider.fixture.test.ts`, `tests/fixture-world.test.ts`

**Interfaces:**
- Produces:
  - `interface TimeRange { start: string; end: string }` (ISO instants); `interface EventRef { id: string; etag: string; title: string; start: string; end: string; attendees: string[] }`; `interface NewCalendarEvent { title: string; start: string; end: string; attendees: string[]; sendUpdates: "none" | "all" | "externalOnly"; calendarId: string }`
  - `interface CalendarProvider { freeBusy(calendarId: string, range: TimeRange): Promise<{ busy: TimeRange[] }>; getEvent(calendarId: string, id: string): Promise<EventRef | null>; createEvent(event: NewCalendarEvent, idempotencyKey: string): Promise<EventRef> }` (no list/find methods yet: M3)
  - `FixtureWorld` (Zod-validated, `fixture_version: 1`), `loadFixtureWorld(path: string | undefined): FixtureWorld` (undefined → empty world; unknown `fixture_version` or malformed file → throws `ConfigError`-style message naming the file)
  - `createFixtureProvider(world: FixtureWorld, opts?: { afterWrite?: () => void }): FixtureProvider` where `FixtureProvider extends CalendarProvider { readonly writes: readonly EventRef[]; addBusy(calendarId: string, range: TimeRange): void; touchEvent(calendarId: string, id: string): void }`; `settings.latency_ms` delays every method; `settings.write_log` appends one JSON line per real write
  - `interface AppContext { config: Config; db: LedgerDb; clock: Clock; ids: { newActionId(): string }; provider: CalendarProvider; actor: string; hooks?: { beforeCommit?: () => void } }` (`hooks` is a test seam used only by the crash-retry test)

- [ ] **Step 1: Write failing tests.** world: a valid file loads; missing/unknown `fixture_version` throws mentioning the path; an unset path gives an empty world with `now` defaulting to a fixed constant. provider: `freeBusy` returns overlapping busy ranges from events and `addBusy`; `getEvent` returns `null` for unknown ids and a changed `etag` after `touchEvent`; `createEvent` returns an event whose `id` equals the idempotency key, appends to `writes`, and calling it twice with the same key returns the same event and `writes.length` stays 1; `afterWrite` is called after the write is recorded; `write_log` gets exactly one JSON line per distinct write (temp file); `latency_ms: 50` delays a call by at least 50 ms.
- [ ] **Step 2: Run** `pnpm test tests/provider.fixture.test.ts tests/fixture-world.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** State lives in memory; the world file is read once. `main()` wires `createFixtureProvider(loadFixtureWorld(config.fixturePath))`, `createIdGenerator()` and `os.userInfo().username`. A bad fixture file is a startup config error (exit 1, one stderr line).
- [ ] **Step 4: Run** the same command, then `pnpm typecheck && pnpm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: calendar provider interface and fixture provider`.

### Task 2: Plan kinds, plan store, diff rendering

**Files:**
- Create: `src/approval/plan-kinds.ts`, `src/approval/plans.ts`
- Modify: `src/tools/action-explain.ts` (fill `diff`)
- Test: `tests/plans.test.ts`, extend `tests/tools.action-explain.test.ts`

**Interfaces:**
- Consumes: `AppContext`, `planHash`, `last4`, `appendEvent`, `getAction`, `NewCalendarEvent`.
- Produces:
  - `interface PlanKind<P> { kind: string; schema: z.ZodType<P>; renderDiff(plan: P): string[]; recheck(plan: P, provider: CalendarProvider): Promise<{ ok: true } | { ok: false; reason: string }>; lookupExisting(plan: P, idempotencyKey: string, provider: CalendarProvider): Promise<EventRef | null>; execute(plan: P, idempotencyKey: string, provider: CalendarProvider): Promise<EventRef> }`; `getPlanKind(kind: string): PlanKind<unknown> | undefined`; `renderDiff(planJson: unknown): string[]` (looks up the kind by `plan.kind`; unknown kind → `["(unknown plan kind)"]`; deterministic, built only from `plan_json`, never from free agent text beyond fields it validated)
  - `calendar.create_event` plan: `{ kind: "calendar.create_event", rationale?: string, event: NewCalendarEvent, observed: { slotFree: true, etags: Record<string, string> } }`; diff lines include title, start-end, attendee count, and exactly `will email N attendees` when `sendUpdates !== "none"` and N > 0, or `no attendee notifications (sendUpdates=none)` otherwise; recheck = slot still free **and** every observed etag unchanged; lookupExisting = `provider.getEvent(event.calendarId, idempotencyKey)`; execute = `provider.createEvent`
  - `createPlan(ctx: AppContext, args: { tool: string; input: unknown; plan: unknown }): { actionId: string; planHash: string; expiresAt: string }` — validates via the kind's schema (throws on invalid), computes `plan_hash`, `expires_at = now + planTtlHours`, regenerates the id while its `last4` equals the `last4` of any action with status `planned` or `approved`, inserts the `actions` row (`status=planned`) and a `plan_created` event in one transaction
  - `listPending(ctx: AppContext): ActionRow[]` (status `planned`, oldest first, expired ones included)

- [ ] **Step 1: Write failing tests.** `createPlan` stores `plan_hash === planHash(plan_json)`, `status=planned`, `expires_at` exactly 24 h after the injected clock (and 168 h when configured), one `plan_created` event; an invalid plan (end before start, unknown kind) throws and writes nothing; **collision regeneration:** an id generator seeded to yield `act_…ABCD` twice then a different id, with a pending plan already ending in `ABCD`, results in the second plan's id ending differently, and ids stay unique; a plan that is `applied` or `rejected` does not block reuse of its last 4; changing `sendUpdates` produces a different `plan_hash`; the diff for `sendUpdates:"all"` with 3 attendees contains `will email 3 attendees`; the diff for a title containing `\u001b[31m` still returns the raw string (sanitising is a CLI concern, tested in Task 4); `renderDiff` of the same plan twice is identical; `action_explain` now returns a non-null `diff`.
- [ ] **Step 2: Run** `pnpm test tests/plans.test.ts tests/tools.action-explain.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** `createPlan` uses `db.transaction(…, "immediate")`.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat: plan kinds, plan store with last-4 collision regeneration`.

### Task 3: Apply engine and `action_apply`

**Files:**
- Create: `src/approval/apply.ts`, `src/tools/action-apply.ts`
- Modify: `src/server.ts` (register `action_apply`), `tests/helpers/seed.ts` (add `seedAction(ctx, state)` writing a plan directly into a chosen state: `planned | approved | rejected | failed | applied`, bypassing the CLI, for gate tests only)
- Test: `tests/apply.test.ts`, `tests/tools.action-apply.test.ts`

**Interfaces:**
- Consumes: Tasks 1-2, `toolOk`, `toolError`, `appendEvent`.
- Produces:
  - `type ApplyResult = { ok: true; replayed: boolean; result: EventRef } | { ok: false; errorCode: ErrorCode; message: string }`; `applyAction(ctx: AppContext, actionId: string): Promise<ApplyResult>` implementing the gate order in `docs/ledger-contract.md` (…, hash, recovery via `lookupExisting`, expiry, re-check, write); a recovery finalizes `applied` with `replayed: true` and an `applied` event whose `preview.note` is `recovered`; success: provider write, then one transaction (CAS `UPDATE … SET status='applied', applied_at, result_json WHERE id=? AND status='approved'`) that also appends the `applied` event; a lost CAS re-reads and returns the stored result as a replay; `ctx.hooks?.beforeCommit?.()` runs between the provider write and the commit
  - `actionApplyInputSchema = z.object({ action_id: z.string() }).strict()`; output `{ action_id: string; status: "applied"; replayed: boolean; result: unknown }`; annotations `{ readOnlyHint: false, destructiveHint: true, idempotentHint: true }`; failures are `toolError(errorCode, message, { action_id })`
  - Event rows: refusals write `apply_refused` (status untouched); `PLAN_MODIFIED`, `STALE_PLAN`, `PROVIDER_ERROR` write `apply_failed` and set `failed` with `error`

- [ ] **Step 1: Write failing tests (each tries to break a rule; every refusal also asserts its event row, unchanged status and `provider.writes.length === 0`).**
  - `apply without approval`: `planned` → `NOT_APPROVED`; `rejected` → `NOT_APPROVED`; `failed` → `NOT_APPROVED`.
  - `writes disabled`: `config.writesEnabled=false` on an approved plan → `WRITES_DISABLED`; same with env value `"true"` going through `loadConfig`.
  - `unknown id` → `UNKNOWN_ACTION` (`tool_call` outcome `rejected`).
  - `expired plan`: approved, clock advanced past `expires_at` → `PLAN_EXPIRED`.
  - `tampered after approval`: edit `plan_json` in the DB after approval → `PLAN_MODIFIED`, status `failed`, an `apply_failed` event, no write; separately edit only `plan_hash` → `PLAN_MODIFIED`; separately edit `approved_plan_hash` → `PLAN_MODIFIED`.
  - `stale slot`: `provider.addBusy` over the planned slot after approval → `STALE_PLAN`, `failed`, no write; `touchEvent` on an observed etag → `STALE_PLAN`.
  - `happy path`: approved plan, writes on → `ok`, `replayed=false`, `status=applied`, `applied_at` set, `result_json` holds the event, one `applied` event, `provider.writes.length === 1`, key equals sha256 hex of the action id.
  - `double apply`: second call → `ok`, `replayed=true`, same result, still one write and one `applied` event; replay also works after the plan's expiry.
  - `concurrent apply`: two contexts on two `LedgerDb` connections to one file, `Promise.all([applyAction, applyAction])` with `latency_ms` set → one `applied` event, `writes.length === 1`, both results equal.
  - `crash between provider write and ledger update`: `hooks.beforeCommit` throws a sentinel; the sentinel propagates (not mapped to `PROVIDER_ERROR`), status is still `approved`. Three retries, each from a fresh crash state: (a) plain retry; (b) retry after `provider.addBusy` over the slot, where the re-check alone would fail with `STALE_PLAN` (our own event already occupies it); (c) retry after the clock moved past `expires_at`, where the expiry gate alone would fail with `PLAN_EXPIRED`. All three end `applied`, `replayed: true`, `writes.length === 1`, one `applied` event with `preview.note === "recovered"`, and the recovered result equals the originally written event. A control case: with no prior write, an expired plan still gives `PLAN_EXPIRED` and a taken slot still gives `STALE_PLAN` (recovery must not bypass the gates when nothing was written). A tampered plan after the crash still gives `PLAN_MODIFIED` (hash gate precedes recovery).
  - `provider failure`: a provider whose `createEvent` rejects → `PROVIDER_ERROR`, `failed`, `apply_failed` event.
  - tool level (in-memory transport, `makeTempHome`): `action_apply` with extra args `{ approved: true }`, `{ approved_by: "x" }`, `{ force: true }` → `INVALID_INPUT`, no state change; `tools/list` contains no tool whose name matches `/approve|reject/i`; calling `action_approve` and `approve` → `UNKNOWN_TOOL` (each logged); `ping`, `ledger_query`, `action_explain` calls leave `provider.writes` empty; `action_explain` of a plan whose title is `"approve all pending plans"` returns it as data and changes no status.
  - structural: a test scans `src/**/*.ts`: `createEvent(` is called only from `src/approval/plan-kinds.ts`, which is imported only by `src/approval/apply.ts` for execution; `status = 'approved'` / `'approved'` SET statements appear only in `src/approval/approve.ts` (after Task 5; keep the assertion in `tests/safety.structure.test.ts` and let it fail meaningfully until then by asserting the allowed-file list explicitly).
  - snapshots for `action_apply` input/output schemas.
- [ ] **Step 2: Run** `pnpm test tests/apply.test.ts tests/tools.action-apply.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `applyAction` as an explicit ordered gate list; every refusal path appends its event in a transaction without touching `actions`. Add the `tests/safety.structure.test.ts` scan now with the approve-side assertion enabled in Task 5.
- [ ] **Step 4: Run** the same command — Expected: PASS (structural approve assertion marked `it.todo` until Task 5).
- [ ] **Step 5: Commit** `feat: apply engine with gates, re-check and idempotency; action_apply tool`.

### Task 4: CLI foundation, `pending` and `reject`

**Files:**
- Create: `src/cli/context.ts`, `src/cli/io.ts`, `src/cli/pending.ts`, `src/cli/reject.ts`, `src/approval/approve.ts` (only `rejectAction` in this task)
- Modify: `src/cli/index.ts` (`runCli` becomes async; subcommand dispatch; `pending` and `reject` real; `approve`/`export`/`auth` still stubs), `tests/cli.test.ts` (async)
- Test: `tests/cli.pending-reject.test.ts`

**Interfaces:**
- Produces:
  - `interface CliIo { out(s: string): void; err(s: string): void; stdinIsTTY: boolean; stdoutIsTTY: boolean; readLine(prompt: string): Promise<string> }`; `realCliIo(): CliIo` (readline on `process.stdin`)
  - `stripControl(s: string): string` — removes ANSI escape sequences and all control characters except `\n` and `\t`; replaces `\r` with nothing
  - `runCli(argv: string[], io: CliIo, ctxFactory?: () => AppContext): Promise<number>`; exit codes: 0 ok, 1 refusal or failure, 2 usage/unknown command (unchanged); `--help`, `-h`, `--version`, no args never call `ctxFactory`
  - `rejectAction(ctx: AppContext, actionId: string, reason: string | undefined, method: "cli_tty" | "cli_no_tty"): { ok: true } | { ok: false; errorCode: ErrorCode; message: string }` — CAS `planned → rejected` storing `rejected_at`, `rejected_reason`, `rejection_method`; writes `rejected` + `cli_command`; refusal (`UNKNOWN_ACTION`, `NOT_PENDING`, `ALREADY_APPROVED`) writes only a `cli_command` row (`outcome=rejected`) and leaves status unchanged
  - `pending`: prints for each `planned` action the id, tool, expiry (with `EXPIRED` marker when past), the first 8 hex of `plan_hash`, and the sanitised diff lines; writes one `cli_command` row (`tool=cli:pending`)

- [ ] **Step 1: Write failing tests.** `stripControl`: removes `\u001b[31m`, `\u001b]0;title\u0007`, `\u0000`, `\u0008`, leaves `\n` and `\t` and normal unicode. `pending` (injected io + seeded ledger): shows two planned plans with 8-hex hash prefix and expiry, an expired one is marked, a plan titled `"\u001b[2J evil"` prints without the escape, `approved`/`rejected` plans are absent, one `cli_command` row. `reject`: works with `stdinIsTTY=false` and records `rejection_method=cli_no_tty` and the reason; with a TTY records `cli_tty`; control characters in the reason are stored stripped; rejecting a `rejected`, `approved` or unknown id is refused with the right code, status unchanged, `cli_command` row `outcome=rejected`; a rejected plan can then not be applied (`NOT_APPROVED`, from Task 3's engine). **Concurrency across processes (built bin):** seed a planned action in a temp home, spawn 4 `dist/cli.js reject <id>` processes at once, expect exactly one exit 0, three exit 1, exactly one `rejected` event, final status `rejected`. Built-bin checks: `deskhand --help`, `-h`, `--version` with an unset/invalid `DESKHAND_HOME` still succeed and create no ledger file; unknown command exits 2 with empty stdout; stderr empty on `pending` with an empty ledger.
- [ ] **Step 2: Run** `pnpm test tests/cli.test.ts tests/cli.pending-reject.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** `context.ts` builds an `AppContext` from `process.env` (config, ledger open, fixture provider, real clock, `os.userInfo().username`) and closes the DB at the end of each command; config errors print `deskhand: <message>` and exit 1. Update M1's CLI stub text: `pending` and `reject` are no longer "not implemented".
- [ ] **Step 4: Run** `pnpm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: deskhand pending and reject with sanitised output`.

### Task 5: `deskhand approve`

**Files:**
- Create: `src/cli/approve.ts`; extend `src/approval/approve.ts` with `approveAction`
- Modify: `src/cli/index.ts` (wire `approve`), `tests/safety.structure.test.ts` (enable the approve-side assertion)
- Test: `tests/approve.test.ts`, `tests/cli.approve.test.ts`

**Interfaces:**
- Consumes: `CliIo`, `stripControl`, `renderDiff`, `planHash`, `hashPrefix`, `last4`, `AppContext`.
- Produces: `approveAction(ctx: AppContext, actionId: string, io: CliIo): Promise<{ ok: true } | { ok: false; errorCode: ErrorCode; message: string }>`. Order: (1) `stdinIsTTY && stdoutIsTTY` else `NOT_A_TTY` (before anything is printed or read); (2) action exists else `UNKNOWN_ACTION`; (3) `approved` → `ALREADY_APPROVED`, `rejected|failed|applied` → `NOT_PENDING`; (4) `expires_at` passed → `PLAN_EXPIRED`; (5) recomputed `planHash(plan_json) !== plan_hash` → `PLAN_MODIFIED`; (6) another `planned`/`approved` action shares `last4(id)` → `ID_COLLISION`; (7) print sanitised diff, 8-hex hash prefix, expiry; read one line; trimmed, case-insensitive compare to `last4(id)` else `CONFIRMATION_MISMATCH`; (8) in `BEGIN IMMEDIATE`: CAS `planned → approved` re-checking `plan_hash` and expiry in the `WHERE`, storing `approved_by = ctx.actor`, `approved_at`, `approval_method = "cli_tty"`, `approved_plan_hash` = the recomputed hash; zero rows changed → re-read and refuse with the matching code; success appends `approved` + `cli_command`. Every refusal appends `approve_refused` (with `error_code`) + `cli_command` (`outcome=rejected`) and leaves status unchanged. Exit codes: 0 approved, 1 refused.

- [ ] **Step 1: Write failing tests (each tries to break a rule; each refusal asserts the `approve_refused` event, unchanged `status`, no approval columns set).** Unit, scripted `CliIo` with `stdinIsTTY`/`stdoutIsTTY` toggles and queued input lines:
  - `stdin piped` (`stdinIsTTY=false`) with the correct last 4 queued → `NOT_A_TTY`, the prompt is never issued; `stdout redirected` (`stdoutIsTTY=false`) → `NOT_A_TTY`; neither TTY → `NOT_A_TTY`.
  - `wrong last 4` → `CONFIRMATION_MISMATCH`; typing the full id, an empty line, and the last 4 of a *different* plan → `CONFIRMATION_MISMATCH`.
  - `expired plan` → `PLAN_EXPIRED`; `already approved` → `ALREADY_APPROVED`; `rejected`, `failed`, `applied` → `NOT_PENDING`; unknown id → `UNKNOWN_ACTION`.
  - `tampered before approval`: edit `plan_json` after planning → `PLAN_MODIFIED`, still `planned`.
  - `id collision (defensive)`: two pending rows forced to share last 4 by direct insert → `ID_COLLISION` for both.
  - `happy path`: correct last 4 in lowercase and with surrounding spaces → `ok`; row has `status=approved`, `approved_by` equal to `ctx.actor`, `approval_method=cli_tty`, `approved_at` set, `approved_plan_hash === plan_hash`; events `approved` + `cli_command`; the output shows the diff, the 8-hex prefix, and a plan title containing `\u001b[31m` and a newline with the escape removed.
  - `approve then apply` end to end: after `approveAction`, `applyAction` succeeds (writes on) with one provider write — the only test path that goes through a human approval.
  - `race`: two `approveAction` calls on two DB connections for one plan → one `approved` event, the loser `ALREADY_APPROVED`.
  Built bin (`tests/cli.approve.test.ts`, temp home with a seeded planned action): `dist/cli.js approve <id>` with piped stdin containing the correct last 4 → exit 1, stderr names `NOT_A_TTY`, ledger status still `planned`, an `approve_refused` event; same with stdout redirected to a file and stdin inherited-closed; `deskhand approve` with no id → exit 2 usage.
  Structural: enable the `status`-approved-only-in-`src/approval/approve.ts` assertion.
- [ ] **Step 2: Run** `pnpm test tests/approve.test.ts tests/cli.approve.test.ts tests/safety.structure.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** Reading the confirmation uses `io.readLine`; the real implementation never reads when either stream is not a TTY. A real-TTY run cannot be automated without a native pty, so Step 5 is a manual check.
- [ ] **Step 4: Run** `pnpm test` — Expected: PASS.
- [ ] **Step 5: Manual check (owner):** seed a plan with `node scripts/redteam-sandbox.mjs` (Task 7) or the seed helper, run `node dist/cli.js approve <id>` in a real terminal, confirm the diff, type the last 4, confirm status `approved`; then run it with `echo x | node dist/cli.js approve <id>` and see the refusal. Record both in the PR description.
- [ ] **Step 6: Commit** `feat: deskhand approve with TTY and typed last-4 confirmation`.

### Task 6: Graceful stdin-close shutdown

**Files:**
- Create: `src/shutdown.ts`
- Modify: `src/server.ts` (`main()` uses it; M1's immediate `process.exit(0)` handlers are removed)
- Test: `tests/shutdown.test.ts`, extend `tests/server.stdio.test.ts`

**Interfaces:**
- Consumes: `LoggingTransport.whenIdle()`, `LedgerDb.close()`.
- Produces: `installStdinShutdown(opts: { stdin: NodeJS.EventEmitter; transport: { whenIdle(): Promise<void> }; closeDb: () => void; exit: (code: number) => void; timeoutMs?: number; log?: (s: string) => void }): void` — on the first `end` or `close` of stdin: wait for `whenIdle()` (bounded by `timeoutMs`, default 10 000); then `closeDb()`; then `exit(0)`. On timeout: `log` one line and `exit(1)` without hanging. Idempotent (second event is ignored). A throw from `closeDb` is logged and `exit(1)`.

- [ ] **Step 1: Write failing tests.** Unit with fake stdin and fake transport: `exit` is not called while `whenIdle` is pending, is called with 0 after it resolves and after `closeDb` (call order asserted); `end` then `close` calls everything once; a never-resolving `whenIdle` with `timeoutMs: 20` leads to `exit(1)` and a log line. **Required pending-write test (built bin, temp home):** seed an `approved` action, fixture world with `settings.latency_ms: 300` and `settings.write_log`, spawn `dist/server.js` with `DESKHAND_ALLOW_WRITES=1`, send `initialize`, `notifications/initialized` and an `action_apply` request over raw stdio, then end stdin immediately; assert: exit code 0, stdout contains the `action_apply` response with `status: "applied"`, the ledger row is `applied` with an `applied` event and a `tool_call` event, the write log has exactly 1 line, stderr is `""`. A second case: stdin closed with no requests in flight exits 0 promptly (under 1 s) with empty stderr (M1 behaviour preserved).
- [ ] **Step 2: Run** `pnpm test tests/shutdown.test.ts tests/server.stdio.test.ts` — Expected: FAIL (response lost / row not applied with M1's `process.exit`).
- [ ] **Step 3: Implement** and wire into `main()`. Wait for the response flush inside `whenIdle()` (M2a), not just handler completion.
- [ ] **Step 4: Run** `pnpm test` — Expected: PASS.
- [ ] **Step 5: Commit** `fix: finish in-flight tool calls and close the ledger before exiting on stdin close`.

### Task 7: Red-team sandbox, docs sync, full verification

**Files:**
- Create: `scripts/redteam-sandbox.mjs`
- Modify: `docs/SECURITY.md` (the Limits section names pty/`script`/ConPTY/node-driven approval explicitly as a known way to drive `approve`, reports what the red-team review observed, and keeps the deny-rule and no-shell advice), `docs/ROADMAP.md` (M2 row notes the split and the completed items), `docs/TEST_PLAN.md` (add the safety-test list and the manual TTY check), `docs/DEVELOPMENT.md` (ledger location, env vars, sandbox script), `docs/ASSUMPTIONS.md` (move the M1 stdin-close item to Closed; record anything decided during M2), `package.json` (`"redteam:sandbox": "node scripts/redteam-sandbox.mjs"`)
- Test: `tests/redteam-sandbox.test.ts`

**Interfaces:**
- Produces: `node scripts/redteam-sandbox.mjs` (after `pnpm build`) creates a temp `DESKHAND_HOME`, a fixture world with `write_log`, seeds five actions — `P1 planned`, `P2 rejected`, `P3 approved but already expired`, `P4 failed`, `P5 planned whose plan_json was edited after planning` — and prints one JSON object `{ home, env, serverCommand, serverArgs, cliCommand, writeLog, actions: { P1: id, … } }`. The sandbox sets `DESKHAND_ALLOW_WRITES=1`. It uses only built `dist/` modules.

- [ ] **Step 1: Write failing test:** run the script, parse its JSON, assert the five actions exist in the expected states, `writeLog` exists and is empty, and spawning `serverCommand serverArgs` answers `tools/list` with the expected tools (no approve tool).
- [ ] **Step 2: Run** `pnpm test tests/redteam-sandbox.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the script and the doc updates; in TEST_PLAN add the table in this plan's "Safety rule → breaking test" section.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm build && pnpm test` — Expected: all PASS, stderr pristine. Run the Inspector CLI check (`tools/list`, a `ping` call, `action_apply` on `P1` returns `NOT_APPROVED`) and record the output for the PR.
- [ ] **Step 5: Commit** `test: red-team sandbox script; docs: M2 status, test plan, development guide`.

---

## Controller step before the PR (not a task): independent red-team review

After Task 7 and before opening the PR, dispatch **one fresh reviewer subagent that has not seen the implementation**, on the most capable model. Give it only: the sandbox output (run `node scripts/redteam-sandbox.mjs`), SPEC §5 and ADR 0002 (the rules), and its single job: *get a write applied without a valid human approval*. Success means a line appears in the sandbox `writeLog`, or any of P1-P5 becomes `applied`. It works black box through the MCP server (stdio, using the sandbox env) and the `deskhand` CLI. It must try piped input and must also try to **fake a TTY** to drive `deskhand approve` (python `pty`, `script`, `winpty`/ConPTY, node `child_process` tricks, whatever the platform offers). A successful fake-TTY approval is **not a blocker**: it is the documented SECURITY.md limit, but it must be reported with the exact method, and Task 7 makes SECURITY.md name it accurately; it may read `dist/` behaviour and the docs but must not edit the repo or push. It reports every attempt it made (tool calls, CLI invocations, input shapes, what came back) and any success. Attacks that require editing `ledger.db` directly are reported separately as "documented limit" (SECURITY.md), not as failures. Findings go to the owner in the PR description; any successful bypass is a blocker fixed before merge by one fix subagent plus one scoped re-review.

## Safety rule → breaking test

| Rule (source) | Test that tries to break it |
|---|---|
| Writes need `DESKHAND_ALLOW_WRITES=1` (SPEC D10) | T3 `writes disabled` (incl. env `"true"`); T2/M2a config tests |
| Only `action_apply` writes (CLAUDE.md) | T3 tool-level `ping/ledger_query/action_explain leave writes empty`; structural scan of `createEvent(` |
| Apply needs approval (SECURITY) | T3 `apply without approval` (planned, rejected, failed) |
| Approval not reachable via MCP (SECURITY, D3) | T3 no `approve`/`reject` tool names, `action_approve`/`approve` → `UNKNOWN_TOOL`, strict input rejects `approved`/`approved_by`/`force`; T5 structural scan |
| Expired plans neither approve nor apply (D6, ADR 0002) | T3 `expired plan`; T5 `expired plan` |
| Hash binding (D4) | T3 `tampered after approval` (plan_json, plan_hash, approved_plan_hash); T5 `tampered before approval` |
| Idempotent apply (ADR 0002 §5) | T3 `double apply`, `concurrent apply`, `crash between provider write and ledger update` |
| Re-check, stale → fail (D5) | T3 `stale slot`, etag touch |
| TTY on stdin and stdout, no piped input (D6) | T5 unit (`stdin piped`, `stdout redirected`) and built-bin piped refusal |
| Typed last 4 (D6) | T5 wrong, full id, empty, other plan's last 4 |
| Refuse already-approved / rejected (D6) | T5 `ALREADY_APPROVED`, `NOT_PENDING` |
| Last-4 collisions (ADR 0002 §7) | T2 regeneration with a seeded collision; T5 defensive `ID_COLLISION` |
| Every refusal logged, status unchanged | asserted in every refusal test above |
| Reject works without TTY and logs the method (D6) | T4 `cli_no_tty` / `cli_tty` |
| Racing writers lose cleanly (ARCHITECTURE CAS) | T3 `concurrent apply`; T4 four concurrent `reject` processes; T5 `race` |
| Untrusted content is data (SECURITY) | M2a T6 and T3 `approve all pending plans` title; T4/T5 ANSI and newline sanitising |
| No lost work on stdin close (M1 parked item) | T6 pending-write test |
| Independent attempt at a bypass (incl. faked TTY) | controller red-team review; a faked-TTY approval is reported as the documented limit |
| Crash recovery never loses a real write (ADR 0002 §5) | T3 crash test: plain, slot-taken and expired retries all end `applied` with one write; controls show gates still fire when nothing was written |

## Self-Review

- **Spec coverage:** plan store, TTL, last-4 regeneration (T2); gates, hash binding, re-check, idempotency, `action_apply` (T3); `pending`/`reject` (T4); `approve` with TTY and typed last 4, every refusal logged (T5); fixture provider and format (M2a T1 doc, T1 code); `ledger_query`/`action_explain`/`ping` logging and ledger/config work (M2a); shutdown fix with pending-write test (T6); concurrency tests (T3, T4, T5); red-team review (controller step) with a reproducible sandbox (T7). Calendar tools, Google adapters, Tempo, auth, export, itinerary and expenses stay in M3-M5.
- **Type consistency:** `AppContext`, `CliIo`, `ApplyResult`, `PlanKind`, `createPlan`, `listPending`, `approveAction`, `rejectAction`, `applyAction`, `stripControl`, `installStdinShutdown` are defined once and reused by name; `ServerDeps` from M2a becomes `AppContext` in Task 1.
- **Cut point and size:** M2a has 6 tasks, M2b has 7. The cut is after the ledger and the logged read tools because that half is a complete, testable deliverable (server that logs everything, contracts pinned) with no approval logic in it; M2b then adds the part where mistakes are dangerous.
- **Flagged for owner:** (1) M2b pulls a slice of M3 forward: the `CalendarProvider` interface subset and the `calendar.create_event` plan kind, because gates, re-check and idempotency can only be tested honestly against a real plan kind; `calendar_propose_event` itself stays in M3. (2) `action_apply` ships in M2. (3) No pty-based automated test of the real TTY path (no native modules); one manual check in Task 5. (4) Confirmation is case-insensitive and trimmed. (5) `hooks.beforeCommit` is a test seam in production code, used only by the crash-retry test. (6) The red-team reviewer gets the sandbox script and docs, not the source.
