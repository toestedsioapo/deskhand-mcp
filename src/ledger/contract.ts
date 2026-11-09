/**
 * Value sets of the ledger contract. These tuples are copied from
 * docs/ledger-contract.md ("Value sets"); a test parses the doc and compares,
 * so the two cannot drift. Changing any of them is a breaking change.
 */
export const LEDGER_SCHEMA_VERSION = 1;

export const ACTION_STATUSES = ["planned", "approved", "applied", "rejected", "failed"] as const;

export const EVENT_KINDS = [
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

export const EVENT_OUTCOMES = ["ok", "error", "rejected"] as const;

export const ERROR_CODES = [
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

export const APPROVAL_METHODS = ["cli_tty"] as const;

export const REJECTION_METHODS = ["cli_tty", "cli_no_tty"] as const;

export type ActionStatus = (typeof ACTION_STATUSES)[number];
export type EventKind = (typeof EVENT_KINDS)[number];
export type EventOutcome = (typeof EVENT_OUTCOMES)[number];
export type ErrorCode = (typeof ERROR_CODES)[number];
export type ApprovalMethod = (typeof APPROVAL_METHODS)[number];
export type RejectionMethod = (typeof REJECTION_METHODS)[number];
