import { projectsApi } from '../api/projects.js';
import { workApi } from '../api/work.js';
import { nativeAutomationsApi } from '../api/nativeAutomations.js';
import { create } from 'zustand';
import { clearAuthToken } from '../api/authToken';
import { boundedSummaryFetcher } from './summaryRefreshCoordinator.js';
import {
  sameGuardianAlerts,
  sameProjects,
} from '../utils/stateGuards';

export const EMPTY_WORK_COUNTS = Object.freeze({
  cancelled: 0,
  done: 0,
  failed: 0,
  history: 0,
  in_progress: 0,
  needs_user: 0,
  operational: 0,
  todo: 0,
  total: 0,
  triage: 0,
  unknown_status_count: 0,
});

export function emptyWorkSummary() {
  return {
    activity: { guarding: 0 },
    contract: 'xuanwu.work-summary.v1',
    counts: { ...EMPTY_WORK_COUNTS },
    project_count: 0,
    project_counts: [],
    scope: { project_id: '' },
  };
}

const fetchWorkSummary = boundedSummaryFetcher(() => workApi.getWorkSummary());

const DATA_SLICE_CONFIG = {
  projects: {
    fetch: () => projectsApi.getProjects(),
    same: sameProjects,
    fallback: [],
  },
  workSummary: {
    fetch: fetchWorkSummary,
    same: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    fallback: emptyWorkSummary(),
  },
  automations: {
    fetch: async () => (await nativeAutomationsApi.list()).automations || [],
    same: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    fallback: [],
  },
};

const ALL_DATA_SLICES = Object.freeze(Object.keys(DATA_SLICE_CONFIG));

function uniqueSlices(slices = ALL_DATA_SLICES) {
  return [...new Set(slices)].filter(key => DATA_SLICE_CONFIG[key]);
}

function buildDataPatch(current, entries) {
  const patch = {};
  entries.forEach(([key, value]) => {
    const config = DATA_SLICE_CONFIG[key];
    const nextValue = value || config.fallback;
    if (!config.same(current[key], nextValue)) {
      patch[key] = nextValue;
    }
  });
  return patch;
}

function buildConnectionPatch(current, online) {
  const patch = {};
  if (current.backendOnline !== online) {
    patch.backendOnline = online;
  }
  if (current.loading) {
    patch.loading = false;
  }
  const connectionState = online ? 'online' : 'offline';
  if (current.backendConnectionState !== connectionState) {
    patch.backendConnectionState = connectionState;
  }
  return patch;
}

export const useDataStore = create((set, get) => ({
  projects: [],
  workSummary: emptyWorkSummary(),
  automations: [],
  guardianAlerts: [],
  loading: true,
  backendOnline: false,
  backendConnectionState: 'offline',

  setBackendOnline: (online) => {
    const backendConnectionState = online ? 'online' : 'offline';
    const current = get();
    if (current.backendOnline === online && current.backendConnectionState === backendConnectionState) return;
    set({ backendConnectionState, backendOnline: online });
  },

  setBackendConnectionState: (backendConnectionState) => {
    if (!['online', 'reconnecting', 'offline'].includes(backendConnectionState)) return;
    const current = get();
    const backendOnline = backendConnectionState === 'online'
      ? true
      : backendConnectionState === 'offline'
        ? false
        : current.backendOnline;
    if (current.backendConnectionState === backendConnectionState && current.backendOnline === backendOnline) return;
    set({ backendConnectionState, backendOnline });
  },

  setProjects: (projects) => {
    set({ projects: Array.isArray(projects) ? projects : [] });
  },

  setGuardianAlerts: (alerts) => {
    const nextAlerts = Array.isArray(alerts) ? alerts : [];
    if (sameGuardianAlerts(get().guardianAlerts, nextAlerts)) return;
    set({ guardianAlerts: nextAlerts });
  },

  refreshData: async (slices = ALL_DATA_SLICES) => {
    const selectedSlices = uniqueSlices(slices);
    if (selectedSlices.length === 0) {
      const current = get();
      const patch = current.loading ? { loading: false } : {};
      if (Object.keys(patch).length > 0) set(patch);
      return;
    }

    try {
      const entries = await Promise.all(
        selectedSlices.map(async key => [key, await DATA_SLICE_CONFIG[key].fetch()])
      );
      const current = get();
      const patch = {
        ...buildDataPatch(current, entries),
        ...buildConnectionPatch(current, true),
      };

      if (Object.keys(patch).length > 0) {
        set(patch);
      }
    } catch (err) {
      if (err.status === 401) {
        clearAuthToken();
        window.location.reload();
        return;
      }
      const current = get();
      const patch = {};
      if (current.backendOnline) {
        patch.backendOnline = false;
      }
      if (current.backendConnectionState !== 'offline') {
        patch.backendConnectionState = 'offline';
      }
      if (current.loading) {
        patch.loading = false;
      }
      if (Object.keys(patch).length > 0) {
        set(patch);
      }
    }
  },

  refreshAllData: async () => get().refreshData(ALL_DATA_SLICES),
}));

export const selectProjects = (state) => state.projects;
export const selectWorkSummary = (state) => state.workSummary;
export const selectAutomations = (state) => state.automations;
export const selectGuardianAlerts = (state) => state.guardianAlerts;
export const selectBackendOnline = (state) => state.backendOnline;
export const selectBackendConnectionState = (state) => state.backendConnectionState;
export const selectLoading = (state) => state.loading;
export const selectRefreshData = (state) => state.refreshData;
export const selectRefreshAllData = (state) => state.refreshAllData;
export const selectSetBackendOnline = (state) => state.setBackendOnline;
export const selectSetBackendConnectionState = (state) => state.setBackendConnectionState;
export const selectSetGuardianAlerts = (state) => state.setGuardianAlerts;
export const selectSetProjects = (state) => state.setProjects;
