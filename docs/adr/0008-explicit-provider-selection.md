# 0008 — Explicit provider selection, `PROVIDER_NOT_CONFIGURED` and `NOT_FOUND`

Status: Accepted (owner review, 2026-11-11, M3 plan decisions 1, 2 and 10)

**Context.** In M2 the fixture provider was always wired: `DESKHAND_FIXTURE` only loaded a world, and with it unset the server ran against an empty in-memory world. `action_apply` could therefore record `applied` for a write into a world that dies with the process (ASSUMPTIONS, "For M3").

**Decision.**

1. **The provider is chosen by `DESKHAND_PROVIDER`**, values `fixture` (M3a) and `google` (M3b, not accepted yet). Unset means **no provider**: the server still starts and `ping`, `ledger_query` and `action_explain` work; `action_apply` and the calendar tools refuse. Any other value (including `Fixture`, `""` and `none`) is a startup `ConfigError`.
2. **`DESKHAND_FIXTURE` set without `DESKHAND_PROVIDER=fixture` is a startup error** (`set DESKHAND_PROVIDER=fixture`), so nothing is ever wired implicitly. `DESKHAND_PROVIDER=fixture` with no `DESKHAND_FIXTURE` stays allowed (empty in-memory world): it is now an explicit choice, and Deskbench needs it.
3. **One construction path.** `selectProvider(config)` in `src/composition.ts` builds the provider and the clock for both the server `main()` and `createAppContext` (used by the CLI). `AppContext.provider` is `CalendarProvider | null`.
4. **New error code `PROVIDER_NOT_CONFIGURED`** for the refusal. It is a gate refusal (outcome `rejected`). In `action_apply` it is gate 1b: after the writes flag (so "writes off" keeps answering first) and before the action lookup. It leaves the plan status unchanged.
5. **New error code `NOT_FOUND`**, added in the same migration (decision 10: checked against the M3b plan and the M4/M5 tool surface). It means a thread, message or event id that does not exist at the provider; first used in M4. It is in the value set, the code table and the CHECK, and no M3 code emits it.
6. **Ledger schema v3.** Migration 3 rebuilds `events` for the CHECK, the same technique as migration 2.

**Rejected alternative.** Reusing `PROVIDER_ERROR` for "nothing configured" would avoid the migration but make it look like a failed write to Deskbench.

**Consequences.** A ledger contract change (`docs/ledger-contract.md`, v3). Every harness or spawn that passes `DESKHAND_FIXTURE` also passes `DESKHAND_PROVIDER=fixture`.
