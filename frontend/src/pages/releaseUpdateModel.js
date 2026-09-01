const ACTIVE_STATES = new Set(['pending', 'running']);

export function isActiveReleaseJob(job) {
  return ACTIVE_STATES.has(job?.state);
}

export function releaseStatus(data = {}, job = null) {
  if (isActiveReleaseJob(job)) return job.state;
  if (job?.state === 'succeeded' && data.current === job.target_version) return 'succeeded';
  if (job?.state === 'failed' && data.current === job.from_version && data.latest === job.target_version) return 'failed';
  if (!data.supported) return 'unsupported';
  return data.update_available ? 'available' : 'current';
}
