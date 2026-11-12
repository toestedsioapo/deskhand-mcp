import { z } from "zod";
import { VISIBLE_ASCII } from "../util/sanitize.js";

/**
 * A calendar id as a tool input: 1 to 256 printable ASCII characters, no
 * whitespace and no control characters. Google's ids are `primary` or
 * address-like (`en.usa#holiday@group.v.calendar.google.com`), so nothing real
 * is excluded. The id is printed on the `calendar:` line of the approve diff,
 * verbatim, so a value with a line break or a hidden character must never
 * reach a plan (the stored-plan schema enforces the same pattern).
 */
export const calendarIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(VISIBLE_ASCII, { message: "calendar_id must be printable ASCII with no whitespace" });
