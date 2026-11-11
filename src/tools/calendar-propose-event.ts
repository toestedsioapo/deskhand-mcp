import { z } from "zod";
import type { AppContext } from "../app-context.js";
import { renderDiff, type CalendarCreateEventPlan } from "../approval/plan-kinds.js";
import { createPlan } from "../approval/plans.js";
import { isIanaTimeZone } from "../util/local-time.js";
import { requireProvider } from "./provider-guard.js";
import { toolError, toolOk, type ToolErrorResult, type ToolOkResult } from "./result.js";

export const calendarProposeEventInputSchema = z
  .object({
    title: z.string().min(1).max(200),
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
    attendees: z.array(z.email().max(254)).max(50).default([]),
    send_updates: z.enum(["none", "all", "externalOnly"]).default("none"),
    calendar_id: z.string().min(1).max(256).default("primary"),
    time_zone: z.string().max(64).optional(),
    rationale: z.string().max(500).optional(),
  })
  .strict();

export const calendarProposeEventOutputSchema = z.object({
  action_id: z.string(),
  plan_hash: z.string(),
  expires_at: z.string(),
  diff: z.array(z.string()),
  next_step: z.string(),
});

export const CALENDAR_PROPOSE_EVENT_DESCRIPTION =
  "Plan a new calendar event. Checks that the slot is free, then stores a plan for a human to review. " +
  "Nothing is created in the calendar: the human must approve it with `deskhand approve <action_id>` " +
  "(a terminal command, not a tool) and only then can action_apply create the event. " +
  "Returns the action id, plan hash, expiry and the diff the human will read.";

type Output = z.infer<typeof calendarProposeEventOutputSchema>;

export async function calendarProposeEventHandler(
  ctx: AppContext,
  input: z.infer<typeof calendarProposeEventInputSchema>,
): Promise<ToolOkResult<Output> | ToolErrorResult> {
  const provider = requireProvider(ctx);
  if ("isError" in provider) return provider;

  if (input.time_zone !== undefined && !isIanaTimeZone(input.time_zone)) {
    return toolError("INVALID_INPUT", `time_zone must be an IANA zone name such as "Europe/Berlin", got "${input.time_zone}".`);
  }
  const start = new Date(input.start);
  const end = new Date(input.end);
  if (end.getTime() <= start.getTime()) return toolError("INVALID_INPUT", "end must be after start.");
  if (start.getTime() <= ctx.clock().getTime()) return toolError("INVALID_INPUT", "start must be in the future.");

  const range = { start: start.toISOString(), end: end.toISOString() };
  try {
    if ((await provider.freeBusy(input.calendar_id, range)).busy.length > 0) {
      return toolError("INVALID_INPUT", `The slot is busy in calendar ${input.calendar_id}; use calendar_find_slots.`);
    }
  } catch {
    return toolError("PROVIDER_ERROR", "The calendar provider failed to read free/busy.");
  }

  const plan: CalendarCreateEventPlan = {
    kind: "calendar.create_event",
    ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
    event: {
      title: input.title,
      ...range,
      attendees: input.attendees,
      sendUpdates: input.send_updates,
      calendarId: input.calendar_id,
      ...(input.time_zone !== undefined ? { timeZone: input.time_zone } : {}),
    },
    observed: { slotFree: true, etags: {} },
  };
  const created = createPlan(ctx, { tool: "calendar_propose_event", input, plan });
  return toolOk(
    {
      action_id: created.actionId,
      plan_hash: created.planHash,
      expires_at: created.expiresAt,
      diff: renderDiff(plan, ctx.config.timeZone),
      next_step: `A human must run: deskhand approve ${created.actionId}`,
    },
    { action_id: created.actionId },
  );
}
