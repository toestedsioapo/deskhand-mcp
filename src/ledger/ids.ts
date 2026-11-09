import { randomBytes } from "node:crypto";

export type Clock = () => Date;

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ISO-8601 UTC with milliseconds and a trailing Z. */
export function isoNow(clock: Clock): string {
  return clock().toISOString();
}

function encode(value: bigint, chars: number): string {
  let out = "";
  let v = value;
  for (let i = 0; i < chars; i++) {
    out = ALPHABET.charAt(Number(v & 31n)) + out;
    v >>= 5n;
  }
  return out;
}

export interface IdGeneratorOptions {
  now?: () => number;
  random?: (bytes: number) => Uint8Array;
}

/** ULID-based action ids: `act_` + 10 chars of ms timestamp + 16 random chars. */
export function createIdGenerator(opts: IdGeneratorOptions = {}): { newActionId(): string } {
  const now = opts.now ?? Date.now;
  const random = opts.random ?? ((n: number) => new Uint8Array(randomBytes(n)));
  return {
    newActionId(): string {
      const time = BigInt(Math.trunc(now())) & ((1n << 48n) - 1n);
      let rand = 0n;
      for (const b of random(10)) rand = (rand << 8n) | BigInt(b);
      return `act_${encode(time, 10)}${encode(rand, 16)}`;
    },
  };
}

/** The last 4 characters of an id, uppercased (the typed approval confirmation). */
export function last4(id: string): string {
  return id.slice(-4).toUpperCase();
}
