import { z } from "zod";
import { PACKAGE_VERSION } from "../config/version.js";

export const pingInputSchema = z.object({}).strict();

export const pingOutputSchema = z.object({
  ok: z.literal(true),
  server: z.literal("deskhand-mcp"),
  version: z.string(),
});

export const PING_DESCRIPTION =
  "Health check. Returns the server name and version. Read-only: has no side effects.";

export function pingHandler(): z.infer<typeof pingOutputSchema> {
  return { ok: true, server: "deskhand-mcp", version: PACKAGE_VERSION };
}
