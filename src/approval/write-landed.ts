import type { AppContext } from "../app-context.js";
import { appendEvent } from "../ledger/events.js";
import { isoNow } from "../ledger/ids.js";

/**
 * Provider write ids recorded in the ledger (M4b live check, 2026-11-25). Gmail rewrites a draft's Message-ID, so a
 * draft is this action's by the draft id Gmail returned, recorded in a `write_landed` row as soon as it is known: right
 * after the POST returns it, or when a lookup adopts a draft by its content. One id belongs to at most one action.
 */
export interface WriteRecords {
  /** The write ids this action recorded, newest first. */
  landed(): string[];
  /**
   * Records `writeId` as this action's, in one `BEGIN IMMEDIATE`. False when another action already recorded it (the
   * id is then never this action's). True, with no new row, when this action already holds it.
   */
  record(writeId: string): boolean;
}

interface LandedRow {
  action_id: string | null;
  preview_json: string;
}

const writeIdOf = (r: LandedRow): string | undefined => {
  try {
    const id = (JSON.parse(r.preview_json) as { output?: { writeId?: unknown } | null }).output?.writeId;
    return typeof id === "string" && id !== "" ? id : undefined;
  } catch {
    return undefined;
  }
};

/** Every action that recorded `writeId`. */
const holders = (ctx: AppContext, writeId: string): string[] =>
  ctx.db
    .all<{ action_id: string | null }>(
      "SELECT action_id FROM events WHERE kind = 'write_landed' AND json_extract(preview_json, '$.output.writeId') = ?",
      [writeId],
    )
    .map((r) => r.action_id ?? "");

export function writeRecords(ctx: AppContext, actionId: string): WriteRecords {
  return {
    landed() {
      const rows = ctx.db.all<LandedRow>(
        "SELECT action_id, preview_json FROM events WHERE action_id = ? AND kind = 'write_landed' ORDER BY id DESC",
        [actionId],
      );
      return rows.map(writeIdOf).filter((id): id is string => id !== undefined);
    },
    record(writeId) {
      return ctx.db.transaction((): boolean => {
        const owners = holders(ctx, writeId);
        if (owners.some((a) => a !== actionId)) return false;
        if (owners.length > 0) return true;
        appendEvent(ctx.db, {
          ts: isoNow(ctx.clock),
          actionId,
          tool: "action_apply",
          kind: "write_landed",
          outcome: "ok",
          preview: { v: 1, input: { action_id: actionId }, output: { writeId }, note: null, action_id: actionId },
        });
        return true;
      }, "immediate");
    },
  };
}
