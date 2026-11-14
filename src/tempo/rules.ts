import { z } from "zod";

/** Wall-clock `HH:mm`, 00:00 to 23:59. */
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
/** Window end: a clock time or `24:00` (end of day). */
const endTime = z.union([clockTime, z.literal("24:00")]);
const interval = z.strictObject({ start: clockTime, end: endTime });
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const day = z.array(interval).optional();

/** Deskhand-owned working-hours rules for one participant; structurally what Tempo accepts. */
export const partyRulesSchema = z.strictObject({
  partyId: z.string().min(1).max(64),
  timeZone: z.string(),
  weeklyRules: z.strictObject({
    monday: day,
    tuesday: day,
    wednesday: day,
    thursday: day,
    friday: day,
    saturday: day,
    sunday: day,
  }),
  blackouts: z.array(localDate).default([]),
});

export type PartyRules = z.input<typeof partyRulesSchema>;
