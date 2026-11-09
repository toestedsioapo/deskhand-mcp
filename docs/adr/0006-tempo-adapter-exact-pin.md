# 0006 — Tempo dependency: exact pin behind `src/tempo/`

Status: Accepted (owner review, 2026-11-09)

**Context.** `@marvinliem/tempo-core@0.1.0` is published (2026-11-06, together with `@marvinliem/tempo@0.1.0`) and is the intended release (owner-confirmed; verified on npm: ESM-only, exports `.`, `./fixtures/*`, `./rules.schema.json`). PLAN.md said "pinned to a major"; that is superseded.

**Decision.** Depend on exactly `"0.1.0"` (no range). Only `src/tempo/` imports it; the rest of Deskhand sees Deskhand-owned types. A contract test over `src/tempo/` using tempo-core's shipped fixtures fails loudly on any Tempo upgrade that changes behaviour. No contingency plan (owner's call).

**Consequences.** Upgrades are deliberate PRs. Tempo being ESM-only forces Deskhand to be ESM-only (D8).
