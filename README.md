# Deskhand MCP

An MCP server that gives AI clients executive-assistant tools (calendar, inbox triage, itineraries, expenses). It is **read-only by default**: every write is planned, approved by a human in a terminal with `deskhand approve`, then applied, and every step is recorded in a local SQLite audit ledger.

**Status: pre-release (M2b).** Only the fixture provider exists; there are no live Google calls yet. The full README (install, Claude Desktop config, deny rules) is written in M6; see `docs/ROADMAP.md`.

## Read this before you connect an agent

**An AI agent that has shell or command tools and runs as you can approve its own plans.** It can fake a terminal, import the approval code, or write the SQLite ledger directly. The terminal approval (TTY plus a typed confirmation) protects you from an agent that can only call MCP tools, and from accidents. It is a speed bump, not a security boundary.

- Run Deskhand only from MCP clients **without shell or command-execution tools**. Example: Claude Desktop without Desktop Commander or a similar tool.
- Do not give the agent a terminal in the same user session.
- Read the diff `deskhand approve` shows before you type the confirmation.
- Planned fix: a stronger out-of-band approval (the Deskflow inbox, or a code shown on another device), so approval no longer depends on a terminal an agent could imitate.

Details and the red-team results are in [`docs/SECURITY.md`](docs/SECURITY.md).

## License

MIT, see `LICENSE`.
