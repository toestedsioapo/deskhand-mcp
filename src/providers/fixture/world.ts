import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { ConfigError } from "../../config/env.js";

/** `now` for an empty world (no fixture file): a fixed constant, for determinism. */
export const DEFAULT_FIXTURE_NOW = "2026-11-10T09:00:00.000Z";

const instant = z.iso.datetime();

const eventSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    start: instant,
    end: instant,
    attendees: z.array(z.string()),
    etag: z.string().min(1),
  })
  .strict()
  .refine((e) => Date.parse(e.start) < Date.parse(e.end), {
    message: "event start must be before end",
    path: ["end"],
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

export const fixtureWorldSchema = z
  .object({
    fixture_version: z.literal(1),
    now: instant,
    calendars: z.record(z.string(), calendarSchema),
    settings: settingsSchema.default({ latency_ms: 0 }),
  })
  .strict();

export type FixtureWorld = z.infer<typeof fixtureWorldSchema>;
export type FixtureEvent = z.infer<typeof eventSchema>;

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
      `DESKHAND_FIXTURE ${path} is not a valid fixture world (version 1)${where}: ${issue?.message ?? "invalid"}`,
    );
  }
  const world = parsed.data;
  const log = world.settings.write_log;
  if (log !== undefined && !isAbsolute(log)) {
    world.settings.write_log = resolve(dirname(resolve(path)), log);
  }
  return world;
}
