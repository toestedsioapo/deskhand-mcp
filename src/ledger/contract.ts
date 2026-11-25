/**
 * Value sets of the ledger contract. These tuples are copied from
 * docs/ledger-contract.md ("Value sets"); a test parses the doc and compares,
 * so the two cannot drift. Changing any of them is a breaking change.
 */
export const LEDGER_SCHEMA_VERSION = 4;

export const ACTION_STATUSES = ["planned", "approved", "applied", "rejected", "failed"] as const;

/** The event kinds of schema v1, frozen: migrations 0001 to 0003 build their CHECK from this. */
export const EVENT_KINDS_V1 = [
  "tool_call",
  "cli_command",
  "plan_created",
  "approved",
  "approve_refused",
  "rejected",
  "applied",
  "apply_refused",
  "apply_failed",
] as const;

/**
 * Schema v4 adds write_claimed (the ledger serialises a draft write, M4b decision 8) and write_landed (the provider's
 * id of a draft this action wrote or adopted, recorded as soon as it is known; M4b live check, 2026-11-25).
 */
export const EVENT_KINDS = [...EVENT_KINDS_V1, "write_claimed", "write_landed"] as const;

export const EVENT_OUTCOMES = ["ok", "error", "rejected"] as const;

/** The error codes of schema v1, frozen: migration 0001 builds its CHECK from this. */
export const ERROR_CODES_V1 = [
  "INVALID_INPUT",
  "WRITES_DISABLED",
  "UNKNOWN_ACTION",
  "UNKNOWN_TOOL",
  "PLAN_EXPIRED",
  "NOT_APPROVED",
  "ALREADY_APPROVED",
  "NOT_PENDING",
  "NOT_A_TTY",
  "CONFIRMATION_MISMATCH",
  "ID_COLLISION",
  "PLAN_MODIFIED",
  "STALE_PLAN",
  "PROVIDER_ERROR",
  "AUTH_REQUIRED",
  "INTERNAL",
] as const;

/** Schema v2 adds UNTRUSTED_RUNTIME (approve refused under --import/--require/--loader/--inspect). Frozen: migration 0002 builds its CHECK from this. */
export const ERROR_CODES_V2 = [...ERROR_CODES_V1, "UNTRUSTED_RUNTIME"] as const;

/** Schema v3 adds PROVIDER_NOT_CONFIGURED (no provider wired) and NOT_FOUND (reserved for M4), in that order. */
export const ERROR_CODES = [...ERROR_CODES_V2, "PROVIDER_NOT_CONFIGURED", "NOT_FOUND"] as const;

export const APPROVAL_METHODS = ["cli_tty"] as const;

export const REJECTION_METHODS = ["cli_tty", "cli_no_tty"] as const;

export type ActionStatus = (typeof ACTION_STATUSES)[number];
export type EventKind = (typeof EVENT_KINDS)[number];
export type EventOutcome = (typeof EVENT_OUTCOMES)[number];
export type ErrorCode = (typeof ERROR_CODES)[number];
export type ApprovalMethod = (typeof APPROVAL_METHODS)[number];
export type RejectionMethod = (typeof REJECTION_METHODS)[number];
