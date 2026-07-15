import { useCallback, useEffect } from 'react';
import { useImmer } from 'use-immer';
import { projectsApi } from '../../api/projects.js';
import { workApi } from '../../api/work.js';
import { runsApi } from '../../api/runs.js';
import { eventsApi } from '../../api/events.js';
import {
  hasIssueEvent,
  RECONCILE_INTERVAL_MS,
  sameIssue,
  sameIssueEvents,
  sameProject,
} from '../../utils/stateGuards';
import { issueStatusFromEvent, parseEventPayload } from './issueDetailEventAdapters';
import { LOG_PAGE_SIZE } from './issueDetailConstants';

async function readOptional(read, label, fallback = null) {
  try {
    return await read();
  } catch (error) {
    console.error(label, error);
    return fallback;
  }
}

function sameIssueRuns(current = [], next = []) {
  if (current === next) return true;
  if (!Array.isArray(current) || !Array.isArray(next)) return false;
  if (current.length !== next.length) return false;
  return current.every((run, index) => issueRunSignature(run) === issueRunSignature(next[index]));
}

function sameAgentProfiles(current = [], next = []) {
  if (current === next) return true;
  if (!Array.isArray(current) || !Array.isArray(next)) return false;
  if (current.length !== next.length) return false;
  return current.every((profile, index) => agentProfileSignature(profile) === agentProfileSignature(next[index]));
}

function sameSupervisorView(current, next) {
  return JSON.stringify(current || null) === JSON.stringify(next || null);
}

function agentProfileSignature(profile) {
  return [
    profile?.id,
    profile?.name,
    profile?.provider,
    profile?.model,
    profile?.reasoning_effort,
    profile?.approval_policy,
    profile?.sandbox,
    profile?.service_tier,
  ].join('\u001f');
}

function issueRunSignature(run) {
  return [
    run?.id,
    run?.attempt,
    run?.status,
    run?.provider,
    run?.provider_session_id,
    run?.provider_turn_id,
    run?.codex_thread_id,
    run?.codex_turn_id,
    run?.started_at,
    run?.ended_at,
    run?.exit_reason,
    run?.error,
    run?.agent_profile_id,
    run?.capability_summary,
    run?.selection_reason,
    run?.service_tier,
    run?.service_tier_source,
  ].join('\u001f');
}

export default function useIssueDetailData(issueId, activeTab) {
  const [detailState, updateDetailState] = useImmer({
    issue: null,
    project: null,
    events: [],
    logEvents: [],
    logsLoaded: false,
    logsLoading: false,
    logsHasMore: false,
    logsError: '',
    unseenLogCount: 0,
    runs: [],
    profiles: [],
    supervisor: null,
    loading: true,
    error: null,
  });

  const loadIssueData = useCallback(async (options = {}) => {
    const { includeProfiles = false } = options;
    try {
      const issueData = await workApi.getIssue(issueId);
      let projData = null;
      let eventList = [];
      let runList = [];
      let profileList;
      let supervisorData = null;

      if (issueData) {
        const [nextProject, nextEvents, nextRuns, nextProfiles, nextSupervisor] = await Promise.all([
          readOptional(() => projectsApi.getProject(issueData.project_id), '获取关联项目失败:'),
          readOptional(
            () => workApi.getIssueEventSummaries(issueId, { excludeTypes: ['issue.log'] }),
            '获取活动事件失败:',
            [],
          ),
          readOptional(() => runsApi.getIssueRuns(issueId), '获取运行历史失败:', []),
          includeProfiles
            ? readOptional(() => projectsApi.getAgentProfiles(), '获取 Agent Profiles 失败:', [])
            : Promise.resolve(undefined),
          readOptional(() => workApi.getIssueSupervisor(issueId), '获取 supervisor 状态失败:', null),
        ]);
        projData = nextProject;
        eventList = nextEvents || [];
        runList = nextRuns || [];
        profileList = Array.isArray(nextProfiles) ? nextProfiles : undefined;
        supervisorData = nextSupervisor;
      }

      updateDetailState(draft => {
        if (!sameIssue(draft.issue, issueData)) draft.issue = issueData;
        if (projData && !sameProject(draft.project, projData)) draft.project = projData;
        if (!sameIssueEvents(draft.events, eventList)) draft.events = eventList;
        if (!sameIssueRuns(draft.runs, runList)) draft.runs = runList;
        if (Array.isArray(profileList) && !sameAgentProfiles(draft.profiles, profileList)) {
          draft.profiles = profileList;
        }
        if (!sameSupervisorView(draft.supervisor, supervisorData)) draft.supervisor = supervisorData;
        if (draft.error !== null) draft.error = null;
        if (draft.loading) draft.loading = false;
      });
    } catch {
      updateDetailState(draft => {
        draft.error = '加载任务详情失败，请检查后端 API 服务。';
        if (draft.loading) draft.loading = false;
      });
    }
  }, [issueId, updateDetailState]);

  useEffect(() => {
    loadIssueData({ includeProfiles: true });

    const unsubscribe = eventsApi.subscribeToEvents((data) => {
      if (Number(data.issueId) !== Number(issueId)) return;
      updateDetailState(draft => {
        if (data.type === 'issue.status_changed' && draft.issue) {
          const nextStatus = issueStatusFromEvent(data);
          if (nextStatus && draft.issue.status !== nextStatus) draft.issue.status = nextStatus;
        }

        if (data.type === 'issue.notification_failed' && draft.issue) {
          const error = data.error || parseEventPayload(data).error || '通知失败';
          draft.issue.error = draft.issue.error ? `${draft.issue.error}\n${error}` : error;
        }

        if (data.type === 'issue.error' && draft.issue) {
          if (draft.issue.error !== data.error) draft.issue.error = data.error;
          if (draft.issue.status !== 'failed') draft.issue.status = 'failed';
        }

        if (data.type === 'issue.log') {
          if (draft.logsLoaded && !hasIssueEvent(draft.logEvents, data)) {
            draft.logEvents.push(data);
          } else if (!draft.logsLoaded) {
            draft.unseenLogCount += 1;
          }
        } else if (!hasIssueEvent(draft.events, data)) {
          draft.events.push(data);
        }
      });
    });

    const interval = setInterval(loadIssueData, RECONCILE_INTERVAL_MS);
    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, [issueId, loadIssueData, updateDetailState]);

  const loadIssueLogs = useCallback(async ({ beforeId = '' } = {}) => {
    updateDetailState(draft => {
      draft.logsLoading = true;
      draft.logsError = '';
    });
    try {
      const nextLogs = await workApi.getIssueEvents(issueId, {
        beforeId,
        limit: LOG_PAGE_SIZE,
        types: ['issue.log'],
      });
      updateDetailState(draft => {
        const page = Array.isArray(nextLogs) ? nextLogs : [];
        if (beforeId) {
          const existingIDs = new Set(draft.logEvents.map(event => event.id).filter(Boolean));
          draft.logEvents.unshift(...page.filter(event => !existingIDs.has(event.id)));
        } else {
          draft.logEvents = page;
          draft.unseenLogCount = 0;
        }
        draft.logsHasMore = page.length === LOG_PAGE_SIZE;
        draft.logsLoaded = true;
        draft.logsLoading = false;
      });
    } catch (loadError) {
      updateDetailState(draft => {
        draft.logsError = loadError.message || '加载日志失败';
        draft.logsLoading = false;
      });
    }
  }, [issueId, updateDetailState]);

  useEffect(() => {
    if (activeTab !== 'logs' || detailState.logsLoaded || detailState.logsLoading) return;
    loadIssueLogs();
  }, [activeTab, detailState.logsLoaded, detailState.logsLoading, loadIssueLogs]);

  useEffect(() => {
    updateDetailState(draft => {
      draft.logEvents = [];
      draft.logsLoaded = false;
      draft.logsLoading = false;
      draft.logsHasMore = false;
      draft.logsError = '';
      draft.unseenLogCount = 0;
    });
  }, [issueId, updateDetailState]);

  return {
    ...detailState,
    loadIssueData,
    loadIssueLogs,
    updateDetailState,
  };
}
