import { z } from "zod";

/**
 * A calendar id as a tool input: 1 to 256 printable ASCII characters, no
 * whitespace and no control characters. Google's ids are `primary` or
 * address-like (`en.usa#holiday@group.v.calendar.google.com`), so nothing real
 * is excluded. The id is printed on the `calendar:` line of the approve diff,
 * so a value with a line break must never reach a plan (the diff also flattens
 * it, see `renderDiff`).
 */
export const calendarIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\x21-\x7e]+$/, { message: "calendar_id must be printable ASCII with no whitespace" });
