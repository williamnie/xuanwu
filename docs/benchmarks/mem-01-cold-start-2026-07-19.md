# MEM-01 cold-start native/RSS baseline

## Environment and method

- macOS 15.7.7, arm64, Bun 1.3.10.
- Controlled before/after binaries were built from commit `88b0c4bf9b0f` in one isolated clone. The after build changed only the MEM-01 lazy-import files and cold-start tracer.
- `scripts/benchmark-cold-start.sh` starts a fresh state directory, serves the real `frontend/dist`, records build/tree metadata and startup phases, checks `/health`, `/api/system/status`, `/api/issues`, `/api/projects`, `/api/runs`, and `/`, then samples both `ps` and `process.memoryUsage()`.
- At startup, after the five-minute warmup, and at shutdown it captures `ps`, `footprint`, and `vmmap -summary`. P95 and drift use the larger of the API and `ps` RSS readings.

## Decisive import chain

The controlled one-module probes identified these idle static chains:

```text
startServer
  -> createDefaultRouter
  -> registerReadApiRoutes
  -> registerPiRoutes
  -> registerPiOAuthRoutes
  -> AuthStorage
  -> @earendil-works/pi-coding-agent/dist/index.js

main Feishu callback -> runPiConversationPrompt -> piRuntime
scheduler -> issueSupervisorDecision -> piRuntime
```

Importing `piOAuthApi.ts` alone fell from 199,245,824 to 69,271,552 RSS bytes after moving the SDK/OAuth imports to the request path. Importing `server.ts` fell from 231,899,136 to 134,447,104 bytes. These probes changed one import edge at a time and did not infer cost from dependency names.

## Controlled before/after

The short run below exists to attribute the import change; the formal budget run is reported separately.

| Measurement | Before | After | Delta |
| --- | ---: | ---: | ---: |
| `ps` initial RSS | 177,856 KiB | 143,376 KiB | -34,480 KiB |
| sampled RSS P95 | 182,353,920 B | 146,849,792 B | -35,504,128 B |
| physical footprint | 105.4 MiB | 72.8 MiB | -32.6 MiB |
| WebKit Malloc resident | 115.1 MiB | 84.6 MiB | -30.5 MiB |
| WebKit Malloc dirty | 91.8 MiB | 61.3 MiB | -30.5 MiB |
| IOAccelerator resident | 3,504 KiB | 3,280 KiB | -224 KiB |
| JS JIT resident | 2,320 KiB | 1,408 KiB | -912 KiB |
| JS VM Gigacage resident | 2,816 KiB | 1,600 KiB | -1,216 KiB |
| SQLite page cache resident | 16 KiB | 16 KiB | 0 |

The original aged live PID 55202 was materially different from heap accounting: `ps` RSS 595,584 KiB and `footprint` 373 MiB, including 197 MiB dirty IOAccelerator, 149 MiB dirty WebKit Malloc, 8,576 KiB SQLite page cache, and 4,224 KiB JS JIT. This is why the regression uses OS RSS plus native-region captures rather than heap alone.

A read-only backup of the 1,078,816,768-byte live database, with `auto_run` and PI auto-manage disabled only in the copy, measured 213,648 KiB `ps` RSS and 85 MiB physical footprint after one minute. Its footprint included 71 MiB WebKit Malloc, 5,040 KiB IOAccelerator, 1,824 KiB JIT, and 256 KiB resident SQLite page cache, remaining under the 256 MiB RSS ceiling without changing schema or deleting data.

## Formal five-minute plus thirty-minute run

- Dirty build stamp: `20260719T144511Z-88b0c4bf9b0f-dirty` (unrelated workspace changes were preserved rather than discarded).
- Run window: 300-second warmup plus 1,803 seconds of process observation; 359 total samples, 307 after warmup. Five-second cadence placed the first/last measured samples 1,797 seconds apart.
- RSS P95 after warmup: **69,140,480 bytes (65.94 MiB)**, versus the 256 MiB budget.
- RSS range/drift after warmup: **26,083,328 bytes (24.88 MiB)**, versus the 32 MiB budget.
- Five-minute capture: `ps` RSS 47,424 KiB and physical footprint 73 MiB. Native regions were 61 MiB dirty WebKit Malloc, 3,312 KiB IOAccelerator, 1,968 KiB JIT, 1,600 KiB JS VM Gigacage, and 272 KiB resident SQLite page cache.
- Last sample at 2,097 seconds: API and `ps` RSS 56,328,192 bytes, heap used 13,155,536 bytes.
- `/health`, `/api/system/status`, `/api/issues`, `/api/projects`, `/api/runs`, and the real frontend static route returned successfully. The frontend route returned HTTP 200.
- Focused behavior regression: 80 tests passed across cold-start, OAuth/provider settings, PI conversation/Supervisor, system status, scheduler, project loop, realtime events, and auto-run paths. Repository-wide `tsc --noEmit` remains red on 121 pre-existing errors, with no error in a MEM-01 touched file.

Reproduce with:

```bash
XUANWU_BINARY=/absolute/path/to/xuanwu \
  ./scripts/benchmark-cold-start.sh
```

The default is 300 seconds warmup followed by 1,800 measured seconds. Artifacts include raw JSONL samples and initial/warmup/final `ps`, `footprint`, `vmmap`, status, route, frontend, build, architecture, and Git tree records.
