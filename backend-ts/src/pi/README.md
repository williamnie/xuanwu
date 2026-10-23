# pi/ — the 玄武 assistant (PI) layer

The assistant that supervises Work: it reads runner state, proposes or executes gated actions,
and keeps memory. Each folder owns one concern; dependencies point roughly downwards.

| Folder | Responsibility |
| --- | --- |
| `runtime/` | Model runtime, persona and system prompt, structured output, session titles, Codex login reuse |
| `tools/` | Tool registry and model-facing tools: builtin catalog, repo/workspace reads, HTTP/browser providers, skill library |
| `mcp/` | MCP tool and resource providers, transport, approval expiry |
| `runnerTools/` | The Runner chat action layer (`runnerActions.ts`) and its tool definitions (issues, sessions, settings, triage) |
| `actions/` | Deterministic action gate: risk, authorization scope, approval policy, freshness, audit envelopes |
| `issues/` | Issue planning bodies, acceptance, completion automation, state snapshots and repairs |
| `supervisor/` | Issue supervisor decisions, recovery diagnosis/budget, commitments, supervisor control tools |
| `guardian/` | Watchdog, guardian events → decisions (merge, rate limit, leases), alerts and daily reports |
| `heartbeat/` | Project heartbeat ticks: signals, orchestration, action execution |
| `memory/` | Reusable memory items, retrieval, reflection worker and memory tools |
| `intake/` | External/IM/CLI input: CLI connectors, manual triggers, LLM intake, event and attention routing |
| `notifications/` | Notification preferences, digests and the IM reply outbox dispatcher |
| `reports/` | Night/run-group reports, project snapshots and findings |
