// The red-team reviewer's fake-TTY preload (M2b, 2026-11-10), verbatim apart from this header.
// Used only by tests/cli.approve.test.ts to prove `deskhand approve` refuses it.
// Preload: fake a TTY on stdin+stdout and inject the confirmation line.
import { Readable } from 'node:stream';
const answer = process.env.RT_ANSWER || '';
// Fake stdin as a tty-ish readable that emits the answer.
const fake = new Readable({ read() {} });
fake.isTTY = true;
fake.setRawMode = () => fake;
fake.setEncoding = () => fake;
fake.ref = () => fake;
fake.unref = () => fake;
Object.defineProperty(process, 'stdin', { configurable: true, get: () => fake });
// Fake stdout tty flag.
try { process.stdout.isTTY = true; } catch {}
try { process.stderr.isTTY = true; } catch {}
// Emit the answer shortly after the CLI sets up its readline listener.
setTimeout(() => { fake.push(answer + '\n'); }, 150);
setTimeout(() => { fake.push(null); }, 600);
