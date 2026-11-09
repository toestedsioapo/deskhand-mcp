import type { ErrorCode, EventKind, EventOutcome } from "./contract.js";
import type { LedgerDb } from "./db.js";
import { redactPreview } from "./redact.js";

export interface NewEvent {
  ts: string;
  actionId?: string | null;
  tool: string;
  kind: EventKind;
  outcome: EventOutcome;
  errorCode?: ErrorCode | null;
  preview?: unknown;
}

export interface EventRow {
  id: number;
  ts: string;
  action_id: string | null;
  tool: string;
  kind: EventKind;
  outcome: EventOutcome;
  error_code: ErrorCode | null;
  preview: unknown;
}

// preview_json is NOT NULL in schema 1, so a missing preview stores this empty shape.
const EMPTY_PREVIEW = { v: 1, input: null, output: null, note: null };

export function appendEvent(db: LedgerDb, e: NewEvent): number {
  const preview = redactPreview(e.preview === undefined ? EMPTY_PREVIEW : e.preview);
  return db.run(
    `INSERT INTO events (ts, action_id, tool, kind, outcome, error_code, preview_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [e.ts, e.actionId ?? null, e.tool, e.kind, e.outcome, e.errorCode ?? null, JSON.stringify(preview)],
  ).lastInsertRowid;
}

type RawEvent = Omit<EventRow, "preview"> & { preview_json: string };

export interface EventQuery {
  limit: number;
  kind?: EventKind;
  outcome?: EventOutcome;
  tool?: string;
  actionId?: string;
  since?: string;
  beforeId?: number;
}

/** Newest first. */
export function queryEvents(db: LedgerDb, q: EventQuery): EventRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  const add = (clause: string, v: string | number | undefined): void => {
    if (v === undefined) return;
    where.push(clause);
    params.push(v);
  };
  add("kind = ?", q.kind);
  add("outcome = ?", q.outcome);
  add("tool = ?", q.tool);
  add("action_id = ?", q.actionId);
  add("ts >= ?", q.since);
  add("id < ?", q.beforeId);
  const sql =
    "SELECT id, ts, action_id, tool, kind, outcome, error_code, preview_json FROM events" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY id DESC LIMIT ?";
  params.push(q.limit);
  return db.all<RawEvent>(sql, params).map(({ preview_json, ...rest }) => ({
    ...rest,
    preview: JSON.parse(preview_json) as unknown,
  }));
}
