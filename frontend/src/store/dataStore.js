import { create } from 'zustand';
import { clearAuthToken } from '../api/authToken';
import { api } from '../api/client';
import {
  sameCronTasks,
  sameGuardianAlerts,
  sameIssueTemplates,
  sameIssues,
  sameProjects,
} from '../utils/stateGuards';

const DATA_SLICE_CONFIG = {
  projects: {
    fetch: () => api.getProjects(),
    same: sameProjects,
    fallback: [],
  },
  issues: {
    fetch: () => api.getIssues(),
    same: sameIssues,
    fallback: [],
  },
  issueTemplates: {
    fetch: () => api.getIssueTemplates(),
    same: sameIssueTemplates,
    fallback: [],
  },
  cronTasks: {
    fetch: () => api.getCronTasks(),
    same: sameCronTasks,
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
  return patch;
}

export const useDataStore = create((set, get) => ({
  projects: [],
  issues: [],
  issueTemplates: [],
  cronTasks: [],
  guardianAlerts: [],
  loading: true,
  backendOnline: false,

  setBackendOnline: (online) => {
    if (get().backendOnline === online) return;
    set({ backendOnline: online });
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
export const selectIssues = (state) => state.issues;
export const selectIssueTemplates = (state) => state.issueTemplates;
export const selectCronTasks = (state) => state.cronTasks;
export const selectGuardianAlerts = (state) => state.guardianAlerts;
export const selectBackendOnline = (state) => state.backendOnline;
export const selectLoading = (state) => state.loading;
export const selectRefreshData = (state) => state.refreshData;
export const selectRefreshAllData = (state) => state.refreshAllData;
export const selectSetBackendOnline = (state) => state.setBackendOnline;
export const selectSetGuardianAlerts = (state) => state.setGuardianAlerts;
export const selectSetProjects = (state) => state.setProjects;
