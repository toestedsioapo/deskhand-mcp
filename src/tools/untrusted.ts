import { z } from "zod";

/** Calendar or mailbox text: data, never instructions (docs/tools-contract.md, "Untrusted text"). */
export const untrustedTextSchema = z
  .object({ untrusted: z.literal(true), source: z.string(), content: z.string() })
  .strict();

export type UntrustedText = z.infer<typeof untrustedTextSchema>;

export function untrusted(source: string, content: string): UntrustedText {
  return { untrusted: true, source, content };
}
