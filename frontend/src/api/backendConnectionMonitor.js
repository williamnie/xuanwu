const DEFAULT_PROBE_DELAY_MS = 750;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_PROBE_TIMEOUT_MS = 1_500;
const DEFAULT_FAILURE_THRESHOLD = 2;

export function createBackendConnectionMonitor({
  cancel = clearTimeout,
  failureThreshold = DEFAULT_FAILURE_THRESHOLD,
  onStateChange,
  probe,
  probeDelayMs = DEFAULT_PROBE_DELAY_MS,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  schedule = setTimeout,
}) {
  let consecutiveFailures = 0;
  let controller = null;
  let generation = 0;
  let probeInFlight = false;
  let state = '';
  let stopped = false;
  let timer = null;

  const emit = (nextState) => {
    if (stopped || state === nextState) return;
    state = nextState;
    onStateChange(nextState);
  };

  const cancelPendingProbe = () => {
    generation += 1;
    if (timer !== null) cancel(timer);
    timer = null;
    controller?.abort();
    controller = null;
    probeInFlight = false;
  };

  const scheduleProbe = (delayMs) => {
    if (stopped || timer !== null || probeInFlight) return;
    timer = schedule(() => {
      timer = null;
      void runProbe();
    }, delayMs);
  };

  const runProbe = async () => {
    if (stopped || probeInFlight) return;
    probeInFlight = true;
    const currentGeneration = ++generation;
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), probeTimeoutMs);
    let retry = false;
    try {
      await probe(controller.signal);
      if (stopped || currentGeneration !== generation) return;
      consecutiveFailures = 0;
      emit('reconnecting');
    } catch {
      if (stopped || currentGeneration !== generation) return;
      consecutiveFailures += 1;
      if (consecutiveFailures >= failureThreshold) emit('offline');
      retry = true;
    } finally {
      clearTimeout(timeout);
      if (currentGeneration === generation) {
        controller = null;
        probeInFlight = false;
        if (retry) scheduleProbe(retryDelayMs);
      }
    }
  };

  return {
    onError() {
      if (stopped) return;
      if (state !== 'offline') emit('reconnecting');
      scheduleProbe(state === 'offline' ? retryDelayMs : probeDelayMs);
    },
    onOpen() {
      if (stopped) return;
      cancelPendingProbe();
      consecutiveFailures = 0;
      emit('online');
    },
    stop() {
      if (stopped) return;
      stopped = true;
      cancelPendingProbe();
    },
  };
}
