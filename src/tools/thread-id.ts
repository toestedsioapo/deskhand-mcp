import { z } from "zod";

/** A mail thread id as a tool input: 1 to 64 characters of `A-Za-z0-9_-` (Gmail hex ids and the fixture ids fit). */
export const threadIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, { message: "thread_id must be 1 to 64 characters of A-Z a-z 0-9 _ -" });
