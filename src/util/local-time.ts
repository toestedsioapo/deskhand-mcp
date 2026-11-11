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
