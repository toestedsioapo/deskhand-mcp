import { createHash } from "node:crypto";
import type { AppContext } from "../../src/app-context.js";
import { createPlan } from "../../src/approval/plans.js";
import type { ActionStatus } from "../../src/ledger/contract.js";
import { createIdGenerator, isoNow } from "../../src/ledger/ids.js";
import { createFixtureMailProvider, createFixtureProvider } from "../../src/providers/fixture/index.js";
import type { FixtureWorld } from "../../src/providers/fixture/world.js";

export const SEED_NOW = "2026-11-10T09:00:00.000Z";

/** A small deterministic fixture world: one calendar with one event. */
export function makeWorld(overrides: Partial<FixtureWorld> = {}): FixtureWorld {
  return {
    fixture_version: 1,
    now: SEED_NOW,
    calendars: {
      primary: {
        events: [
          {
            id: "evt_standup",
            title: "Team standup",
            start: "2026-11-10T09:30:00.000Z",
            end: "2026-11-10T09:45:00.000Z",
            attendees: ["ana@example.com", "ben@example.com"],
            etag: "e1",
          },
        ],
      },
    },
    settings: { latency_ms: 0 },
    ...overrides,
  };
}

/** The non-ledger parts of an AppContext for tests that only need the old ServerDeps. */
export function makeProviderDeps(): Pick<AppContext, "ids" | "provider" | "mail" | "actor"> {
  return {
    ids: createIdGenerator(),
    provider: createFixtureProvider(makeWorld()),
    mail: createFixtureMailProvider(makeWorld()),
    actor: "tester",
  };
}

/** A valid calendar.create_event plan for the world from makeWorld (slot free, standup etag e1). */
export function validPlan(over: Record<string, unknown> = {}, evOver: Record<string, unknown> = {}) {
  return {
    kind: "calendar.create_event",
    rationale: "Sync with Ana",
    event: {
      title: "Sync",
      start: "2026-11-12T10:00:00.000Z",
      end: "2026-11-12T10:30:00.000Z",
      attendees: ["a@example.com", "b@example.com", "c@example.com"],
      sendUpdates: "all",
      calendarId: "primary",
      ...evOver,
    },
    observed: { slotFree: true, etags: { evt_standup: "e1" } },
    ...over,
  };
}

export type SeedState = ActionStatus;

/**
 * Gate tests only: plans through createPlan, then forces the row into `state`
 * directly (bypassing the CLI), filling the columns that state implies.
 * Returns the action id.
 */
export function seedAction(ctx: AppContext, state: SeedState, plan: unknown = validPlan()): string {
  const { actionId, planHash } = createPlan(ctx, { tool: "calendar_propose_event", input: {}, plan });
  const ts = isoNow(ctx.clock);
  const approve = (status: string) =>
    ctx.db.run(
      `UPDATE actions SET status = ?, approved_by = ?, approved_at = ?, approval_method = 'cli_tty',
         approved_plan_hash = ? WHERE id = ?`,
      [status, ctx.actor, ts, planHash, actionId],
    );
  switch (state) {
    case "planned":
      break;
    case "approved":
      approve("approved");
      break;
    case "rejected":
      ctx.db.run(
        `UPDATE actions SET status = 'rejected', rejected_at = ?, rejected_reason = 'seeded',
           rejection_method = 'cli_no_tty' WHERE id = ?`,
        [ts, actionId],
      );
      break;
    case "failed":
      approve("failed");
      ctx.db.run("UPDATE actions SET error = 'seeded failure' WHERE id = ?", [actionId]);
      break;
    case "applied":
      approve("applied");
      ctx.db.run("UPDATE actions SET applied_at = ?, result_json = ? WHERE id = ?", [
        ts,
        JSON.stringify({ id: "seeded", etag: "e1" }),
        actionId,
      ]);
      break;
  }
  return actionId;
}

const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** `body`, `bodyChars` and `bodySha256` for a draft body (what the tool stores). */
export function bodyFields(body: string): { body: string; bodyChars: number; bodySha256: string } {
  return { body, bodyChars: body.length, bodySha256: sha256Hex(body) };
}

export const DRAFT_BODY = "Thanks Ana,\n\nThe numbers look right to me.\n\n-- \nMe";

/**
 * A valid mail.create_draft_reply plan for the thread `th_budget` of draftThreads(): 2 to, 1 cc and 1 bcc that is
 * not on the thread. `draftOver` replaces draft fields (pass `bodyFields(...)` to change the body consistently).
 */
export function validDraftPlan(over: Record<string, unknown> = {}, draftOver: Record<string, unknown> = {}) {
  const rationale = "rationale" in over ? over["rationale"] : "Reply to Ana about the budget";
  return {
    kind: "mail.create_draft_reply",
    rationale: "Reply to Ana about the budget",
    // Follows the reason given in `over`, unless `over` sets its own.
    ...(typeof rationale === "string" ? { rationaleSha256: sha256Hex(rationale) } : {}),
    draft: {
      threadId: "th_budget",
      messageIdHeader: `<deskhand.${"0".repeat(64)}@deskhand.invalid>`,
      inReplyTo: "<m2@example.com>",
      references: ["<m1@example.com>", "<m2@example.com>"],
      from: "me@example.com",
      to: ["ana@example.com", "ben@example.com"],
      cc: ["cara@example.com"],
      bcc: ["dan@example.com"],
      subject: "Re: Q4 budget",
      ...bodyFields(DRAFT_BODY),
      ...draftOver,
    },
    observed: {
      latestMessageId: "m2",
      onThread: ["ana@example.com", "ben@example.com", "cara@example.com", "me@example.com"],
    },
    ...over,
  };
}
