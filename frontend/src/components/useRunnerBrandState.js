import { useEffect, useMemo, useState } from 'react';
import {
  selectBackendOnline,
  selectAutomations,
  selectIssues,
  selectProjects,
  useDataStore,
} from '../store/dataStore';
import { resolveRunnerBrandState } from './brandState.js';

const BRAND_CLOCK_INTERVAL_MS = 60_000;

export function useRunnerBrandState() {
  const backendOnline = useDataStore(selectBackendOnline);
  const issues = useDataStore(selectIssues);
  const projects = useDataStore(selectProjects);
  const automations = useDataStore(selectAutomations);
  const now = useBrandClock();

  return useMemo(() => resolveRunnerBrandState({
    backendOnline,
    issues,
    projects,
    automations,
    now,
  }), [automations, backendOnline, issues, now, projects]);
}

function useBrandClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), BRAND_CLOCK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);

  return now;
}
