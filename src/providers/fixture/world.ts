import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { ConfigError } from "../../config/env.js";

/** `now` for an empty world (no fixture file): a fixed constant, for determinism. */
export const DEFAULT_FIXTURE_NOW = "2026-11-10T09:00:00.000Z";

const instant = z.iso.datetime();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar date: round-trips through Date, so 2026-02-30 is rejected. */
const isRealDate = (s: string): boolean =>
  DATE_RE.test(s) && new Date(`${s}T00:00:00.000Z`).toISOString().startsWith(s);

const eventSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    start: z.string(),
    end: z.string(),
    attendees: z.array(z.string()),
    etag: z.string().min(1),
    all_day: z.boolean().optional(),
    // Additive (no version bump): the calendar owner organises the event. Default true; false models an invite
    // from someone else (Google `organizer.self: false`).
    organizer_self: z.boolean().optional(),
  })
  .strict()
  .superRefine((e, ctx) => {
    const ok = (s: string): boolean =>
      e.all_day === true ? isRealDate(s) : instant.safeParse(s).success;
    const what = e.all_day === true ? "a YYYY-MM-DD date (all_day is true)" : "an ISO-8601 UTC instant";
    for (const key of ["start", "end"] as const) {
      if (!ok(e[key])) ctx.addIssue({ code: "custom", message: `event ${key} must be ${what}`, path: [key] });
    }
    if (ok(e.start) && ok(e.end) && !(Date.parse(e.start) < Date.parse(e.end))) {
      ctx.addIssue({ code: "custom", message: "event start must be before end", path: ["end"] });
    }
  });

const calendarSchema = z
  .object({ events: z.array(eventSchema) })
  .strict()
  .refine((c) => new Set(c.events.map((e) => e.id)).size === c.events.length, {
    message: "duplicate event id within a calendar",
    path: ["events"],
  });

const settingsSchema = z
  .object({
    latency_ms: z.number().int().min(0).default(0),
    write_log: z.string().min(1).optional(),
  })
  .strict();

const addrSchema = z.object({ address: z.string().min(1), name: z.string().optional() }).strict();

const messageSchema = z
  .object({
    id: z.string().min(1),
    message_id: z.string().min(1).optional(),
    date: instant,
    from: addrSchema,
    reply_to: z.array(addrSchema).optional(),
    to: z.array(addrSchema),
    cc: z.array(addrSchema).optional(),
    subject: z.string(),
    body_text: z.string(),
    unread: z.boolean().optional(),
    sent: z.boolean().optional(),
    draft: z.boolean().optional(),
  })
  .strict();

const threadSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "thread id must match [A-Za-z0-9_-]{1,64}"),
    messages: z.array(messageSchema).min(1, "a thread needs at least one message"),
  })
  .strict();

const mailSchema = z
  .object({ owner: z.string().includes("@"), threads: z.array(threadSchema) })
  .strict()
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    for (const t of m.threads) {
      for (const id of [t.id, ...t.messages.map((x) => x.id)]) {
        if (seen.has(id)) ctx.addIssue({ code: "custom", message: `duplicate mail id ${id}`, path: ["threads"] });
        seen.add(id);
      }
    }
  });

export const fixtureWorldSchema = z
  .object({
    fixture_version: z.union([z.literal(1), z.literal(2)]),
    now: instant,
    calendars: z.record(z.string(), calendarSchema),
    mail: mailSchema.optional(),
    settings: settingsSchema.default({ latency_ms: 0 }),
  })
  .strict()
  .refine((w) => w.fixture_version === 2 || w.mail === undefined, {
    message: "mail needs fixture_version 2",
    path: ["mail"],
  });

export type FixtureWorld = z.infer<typeof fixtureWorldSchema>;
export type FixtureEvent = z.infer<typeof eventSchema>;
export type FixtureMessage = z.infer<typeof messageSchema>;
export type FixtureThread = z.infer<typeof threadSchema>;

/**
 * Reads the world file once. Undefined path gives an empty world. Any problem
 * is a ConfigError naming the file. A relative `settings.write_log` is resolved
 * against the fixture file's directory.
 */
export function loadFixtureWorld(path: string | undefined): FixtureWorld {
  if (path === undefined) {
    return { fixture_version: 1, now: DEFAULT_FIXTURE_NOW, calendars: {}, settings: { latency_ms: 0 } };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`DESKHAND_FIXTURE ${path} could not be read: ${why}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ConfigError(`DESKHAND_FIXTURE ${path} is not valid JSON`);
  }
  const parsed = fixtureWorldSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
    throw new ConfigError(
      `DESKHAND_FIXTURE ${path} is not a valid fixture world (version 1 or 2)${where}: ${issue?.message ?? "invalid"}`,
    );
  }
  const world = parsed.data;
  const log = world.settings.write_log;
  if (log !== undefined && !isAbsolute(log)) {
    world.settings.write_log = resolve(dirname(resolve(path)), log);
  }
  return world;
}
