/** True for `UTC` and for `Area/Location` IANA names the runtime knows; offsets, POSIX names like `EST5EDT` and `""` are not. */
export function isIanaTimeZone(tz: string): boolean {
  if (tz !== "UTC" && !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface LocalParts {
  date: string;
  time: string;
  abbr: string;
}

function localParts(iso: string, timeZone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date(iso))) p[part.type] = part.value;
  return {
    date: `${p["weekday"]} ${p["day"]} ${p["month"]} ${p["year"]}`,
    time: `${p["hour"]}:${p["minute"]}`,
    abbr: p["timeZoneName"] ?? timeZone,
  };
}

/**
 * An instant range as wall-clock time in `timeZone`, for a human reading a diff.
 * Same local date and zone abbreviation: `Thu 12 Nov 2026, 11:00 to 11:30 CET (Europe/Berlin)`;
 * otherwise both ends in full. The IANA name is always last, so the abbreviation is never ambiguous.
 */
export function formatLocalRange(startIso: string, endIso: string, timeZone: string): string {
  const a = localParts(startIso, timeZone);
  const b = localParts(endIso, timeZone);
  if (a.date === b.date && a.abbr === b.abbr) {
    return `${a.date}, ${a.time} to ${b.time} ${a.abbr} (${timeZone})`;
  }
  return `${a.date}, ${a.time} ${a.abbr} to ${b.date}, ${b.time} ${b.abbr} (${timeZone})`;
}
