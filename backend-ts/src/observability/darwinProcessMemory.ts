const RUSAGE_INFO_V4 = 4;
const RUSAGE_INFO_V4_BYTES = 256;
const PHYS_FOOTPRINT_OFFSET = 72;

type ProcPidRusage = (pid: number, flavor: number, buffer: unknown) => number;
type DarwinRusageBinding = {
  handle: unknown;
  procPidRusage: ProcPidRusage;
  pointer: (buffer: Uint8Array) => unknown;
};

let bindingPromise: Promise<DarwinRusageBinding | undefined> | undefined;

/**
 * Reads macOS `phys_footprint` without spawning `/usr/bin/footprint`.
 *
 * `footprint` suspends inspected processes and must not be launched by Core
 * against itself. `proc_pid_rusage(RUSAGE_INFO_V4)` is a non-suspending kernel
 * query and works for Core plus its same-user provider descendants.
 */
export async function collectDarwinPhysicalFootprints(pids: number[]): Promise<Map<number, number>> {
  if (process.platform !== "darwin") return new Map();
  const binding = await darwinRusageBinding();
  if (!binding) return new Map();
  const values = new Map<number, number>();
  for (const pid of new Set(pids.filter(positivePID))) {
    const buffer = new Uint8Array(RUSAGE_INFO_V4_BYTES);
    const result = binding.procPidRusage(pid, RUSAGE_INFO_V4, binding.pointer(buffer));
    if (result !== 0) continue;
    const bytes = Number(new DataView(buffer.buffer).getBigUint64(PHYS_FOOTPRINT_OFFSET, true));
    if (Number.isSafeInteger(bytes) && bytes > 0) values.set(pid, bytes);
  }
  return values;
}

async function darwinRusageBinding(): Promise<DarwinRusageBinding | undefined> {
  bindingPromise ??= loadDarwinRusageBinding();
  return await bindingPromise;
}

async function loadDarwinRusageBinding(): Promise<DarwinRusageBinding | undefined> {
  try {
    const ffi = await import("bun:ffi");
    const library = ffi.dlopen("/usr/lib/libproc.dylib", {
      proc_pid_rusage: {
        args: [ffi.FFIType.int32_t, ffi.FFIType.int32_t, ffi.FFIType.ptr],
        returns: ffi.FFIType.int32_t
      }
    });
    // Keep the dlopen handle reachable for the process lifetime. Closing it
    // would invalidate the cached native symbol used by later samples.
    const procPidRusage = library.symbols.proc_pid_rusage;
    return {
      handle: library,
      procPidRusage: (pid, flavor, buffer) => procPidRusage(pid, flavor, buffer as never),
      pointer: (buffer) => ffi.ptr(buffer)
    };
  } catch {
    return undefined;
  }
}

function positivePID(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}
