export function boundedSummaryFetcher(fetcher) {
  let inFlight = null;
  let lastStartedAt = Number.NEGATIVE_INFINITY;
  let trailing = null;
  return () => {
    if (inFlight) return inFlight;
    const now = performance.now();
    const wait = Math.max(0, 1_000 - (now - lastStartedAt));
    if (wait === 0) {
      lastStartedAt = now;
      inFlight = Promise.resolve().then(fetcher).finally(() => { inFlight = null; });
      return inFlight;
    }
    if (!trailing) {
      trailing = new Promise((resolve, reject) => {
        setTimeout(() => {
          trailing = null;
          lastStartedAt = performance.now();
          inFlight = Promise.resolve().then(fetcher).finally(() => { inFlight = null; });
          inFlight.then(resolve, reject);
        }, Math.max(500, wait));
      });
    }
    return trailing;
  };
}
