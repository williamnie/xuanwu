import { create } from 'zustand';
import { api } from '../api/client';
import { sameCronTasks, sameIssueTemplates, sameIssues, sameProjects } from '../utils/stateGuards';

export const useDataStore = create((set, get) => ({
  projects: [],
  issues: [],
  issueTemplates: [],
  cronTasks: [],
  loading: true,
  backendOnline: false,

  setBackendOnline: (online) => {
    if (get().backendOnline === online) return;
    set({ backendOnline: online });
  },

  refreshAllData: async () => {
    try {
      const [projList, issueList, templateList, cronTaskList] = await Promise.all([
        api.getProjects(),
        api.getIssues(),
        api.getIssueTemplates(),
        api.getCronTasks(),
      ]);
      const nextProjects = projList || [];
      const nextIssues = issueList || [];
      const nextTemplates = templateList || [];
      const nextCronTasks = cronTaskList || [];
      const current = get();
      const patch = {};

      if (!sameProjects(current.projects, nextProjects)) {
        patch.projects = nextProjects;
      }
      if (!sameIssues(current.issues, nextIssues)) {
        patch.issues = nextIssues;
      }
      if (!sameIssueTemplates(current.issueTemplates, nextTemplates)) {
        patch.issueTemplates = nextTemplates;
      }
      if (!sameCronTasks(current.cronTasks, nextCronTasks)) {
        patch.cronTasks = nextCronTasks;
      }
      if (!current.backendOnline) {
        patch.backendOnline = true;
      }
      if (current.loading) {
        patch.loading = false;
      }

      if (Object.keys(patch).length > 0) {
        set(patch);
      }
    } catch {
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
}));

export const selectProjects = (state) => state.projects;
export const selectIssues = (state) => state.issues;
export const selectIssueTemplates = (state) => state.issueTemplates;
export const selectCronTasks = (state) => state.cronTasks;
export const selectBackendOnline = (state) => state.backendOnline;
export const selectLoading = (state) => state.loading;
export const selectRefreshAllData = (state) => state.refreshAllData;
export const selectSetBackendOnline = (state) => state.setBackendOnline;
