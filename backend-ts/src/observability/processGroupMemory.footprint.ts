

import { PROCESS_GROUP_MEMORY_FRESHNESS_MS } from './processGroupMemory.model.ts';
import type { FootprintState, ObservedProcess, ProcessGroupMemoryOptions, FootprintMeasurementSource } from './processGroupMemory.model.ts';

import { collectMacOSFootprint } from './processGroupMemory.processes.ts';

export class MemoryFootprintProbe {
  value?: FootprintState;
  attempted = false;
  private generation = 0;
  private inFlight = false;
  constructor(private readonly options: ProcessGroupMemoryOptions,
    private readonly inspectRows: () => ObservedProcess[], private readonly runnerPid: () => number,
    private readonly now: () => Date) {}

  invalidate(): void {
    this.generation += 1;
    this.value = undefined;
    this.attempted = false;
  }

measurement(
    rows: ObservedProcess[],
    p95RSS: number,
    mainRSS: number,
    now: Date
  ): { group_bytes: number; main_bytes: number; source: FootprintMeasurementSource } {
    const footprint = this.value;
    const observedAt = Date.parse(footprint?.observed_at ?? "");
    const footprintInterval = this.options.footprintIntervalMs ?? 60_000;
    const maxAge = Math.max(PROCESS_GROUP_MEMORY_FRESHNESS_MS, footprintInterval * 2);
    if (footprint && footprint.bytes > 0 && footprint.main_bytes > 0
      && footprint.by_identity.size > 0
      && Number.isFinite(observedAt) && now.getTime() - observedAt <= maxAge) {
      let covered = 0;
      let groupBytes = 0;
      let measuredMain = mainRSS;
      for (const row of rows) {
        const physical = footprint.by_identity.get(row.identity);
        if (physical === undefined) {
          groupBytes += row.rss_bytes;
          continue;
        }
        covered += 1;
        groupBytes += physical;
        if (row.pid === this.runnerPid()) measuredMain = physical;
      }
      if (covered > 0) return {
        group_bytes: groupBytes,
        main_bytes: measuredMain,
        source: covered === rows.length ? "footprint" : "footprint+rss"
      };
    }
    return { group_bytes: p95RSS, main_bytes: mainRSS, source: "rss" };
  }

refresh(rows: ObservedProcess[], now: Date): void {
    if (this.options.footprint === false) return;
    if (this.inFlight) return;
    const previous = Date.parse(this.value?.observed_at ?? "");
    const currentIdentities = new Set(rows.map((row) => row.identity));
    const measuredIdentities = new Set(this.value?.by_identity.keys() ?? []);
    const membershipChanged = currentIdentities.size !== measuredIdentities.size
      || [...currentIdentities].some((identity) => !measuredIdentities.has(identity));
    if (!membershipChanged && Number.isFinite(previous)
      && now.getTime() - previous < (this.options.footprintIntervalMs ?? 60_000)) return;
    const expected = new Map(rows.map((row) => [row.pid, row.identity]));
    const generation = this.generation;
    this.inFlight = true;
    void (this.options.footprint ?? collectMacOSFootprint)([...expected.keys()]).then((values) => {
      if (generation !== this.generation) return;
      const live = new Map(this.inspectRows().map((row) => [row.pid, row.identity]));
      const valid = [...values].filter(([pid]) => live.get(pid) === expected.get(pid));
      const validValues = new Map(valid);
      this.value = {
        bytes: valid.reduce((total, [, bytes]) => total + bytes, 0),
        by_identity: new Map(valid.map(([pid, bytes]) => [expected.get(pid)!, bytes])),
        main_bytes: validValues.get(this.runnerPid()) ?? 0,
        observed_at: this.now().toISOString(),
        process_count: valid.length
      };
    }).catch(() => {}).finally(() => {
      if (generation === this.generation) this.attempted = true;
      this.inFlight = false;
    });
  }
}
