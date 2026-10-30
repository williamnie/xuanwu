
import { useProjectNodes } from '../../store/useProjectNodes.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { assistantApi } from '../../api/assistant.js';
import { evidenceApi } from '../../api/evidence.js';

import { handoffsApi } from '../../api/handoffs.js';
import { runsApi } from '../../api/runs.js';
import { projectsApi } from '../../api/projects.js';
import { systemApi } from '../../api/system.js';
import { workApi } from '../../api/work.js';
import { selectRefreshData, useDataStore } from '../../store/dataStore.js';

import { recordFirstDeliveryConnectionTest } from '../../utils/firstDeliveryConnection.js';
import { FIRST_DELIVERY_TITLE, firstDeliveryRecovery, firstDeliveryState, preselectedCodeAgentID } from './firstDeliveryGuideModel.js';
import { createFirstDeliveryConnectionCheck } from './firstDeliverySetup.js';

import { useCodexImportPreview } from '../codexImportPreview.js';

import { useFirstDeliveryActions } from './useFirstDeliveryActions.js';
const EMPTY_SNAPSHOT = { codeAgents: [], connectionTest: null, doctor: null, evidence: [], handoffs: [], runnerSettings: null, works: [] };
export function useFirstDeliveryGuideState({ checkSavedConnection, onOpenWork, projects }) {
  const nodesById = useProjectNodes();
  const refreshData = useDataStore(selectRefreshData);
  const [codexImport, refreshCodexImport] = useCodexImportPreview();
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [cwd, setCwd] = useState('');
  const [selectedCodeAgentID, setSelectedCodeAgentID] = useState('');
  const [selectedProjectID, setSelectedProjectID] = useState(projects[0]?.id || '');
  const [projectConfirmed, setProjectConfirmed] = useState(false);
  const [pathCheck, setPathCheck] = useState({ path: '', result: null, busy: false, error: '' });
  const [connectionCheck, setConnectionCheck] = useState({ busy: true, result: null });
  const connectionCheckRef = useRef(checkSavedConnection || null);
  const [creationNeedsRefresh, setCreationNeedsRefresh] = useState(false);
  const requestRef = useRef(null);
  const targetWorkRef = useRef('');

  const load = useCallback(async () => {
    if (requestRef.current) return requestRef.current.promise;
    setLoading(true);
    const controller = new AbortController();
    const promise = Promise.all([
      systemApi.getRuntimeDoctor()
        .catch(() => ({ service: { alive: false }, db: { ok: false } }))
        .then(doctor => {
          // A failed environment check must remain actionable even if the other
          // status endpoints fail in the same request batch.
          if (!controller.signal.aborted) setSnapshot(current => ({ ...current, doctor }));
          return doctor;
        }),
      systemApi.getCodeAgents(),
      systemApi.getRunnerSettings(),
      workApi.getWorks({ pageSize: 8, query: FIRST_DELIVERY_TITLE }, { signal: controller.signal }),
      handoffsApi.getHandoffs({ limit: 20 }),
    ]);
    requestRef.current = { controller, promise };
    try {
      const [doctor, codeAgentsResponse, runnerSettings, worksPage, handoffPage] = await promise;
      const works = worksPage?.items || [];
      const handoffs = handoffPage?.items || [];
      const sample = works.find(work => work?.title === FIRST_DELIVERY_TITLE);
      const candidateWorkID = [
        targetWorkRef.current,
        sample?.id,
        ...handoffs.filter(item => item?.evidence_count > 0).map(item => item.work_id),
        works[0]?.id,
      ].find(Boolean);
      const delivery = candidateWorkID ? await loadDeliverySnapshot(candidateWorkID) : { evidence: [], handoffs, works };
      targetWorkRef.current = candidateWorkID || '';
      if (controller.signal.aborted) return;
      setSnapshot({
        codeAgents: Array.isArray(codeAgentsResponse?.agents) ? codeAgentsResponse.agents : [],
        doctor,
        ...delivery,
        targetWorkID: candidateWorkID || '',
        runnerSettings,
      });
      setError('');
      setCreationNeedsRefresh(false);
    } catch (loadError) {
      if (loadError?.name !== 'AbortError') setError(loadError.message || '无法读取首次交付状态');
    } finally {
      if (requestRef.current?.promise === promise) requestRef.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    connectionCheckRef.current ||= createFirstDeliveryConnectionCheck(assistantApi);
    connectionCheckRef.current().then(result => {
      if (!active) return;
      recordFirstDeliveryConnectionTest(result);
      setConnectionCheck({ busy: false, result });
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const path = cwd.trim();
    if (!path) return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setPathCheck({ path, result: null, busy: true, error: '' });
      try {
        const result = await projectsApi.checkPath(path, { signal: controller.signal });
        if (!controller.signal.aborted) setPathCheck({ path, result, busy: false, error: '' });
      } catch (failure) {
        if (!controller.signal.aborted) setPathCheck({ path, result: null, busy: false, error: failure.message || '路径检查失败，请重试。' });
      }
    }, 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [cwd]);

  useEffect(() => {
    load();
    return () => {
      const activeRequest = requestRef.current;
      requestRef.current = null;
      activeRequest?.controller.abort();
    };
  }, [load]);
  useEffect(() => {
    if (!projects.some(project => project.id === selectedProjectID)) {
      setSelectedProjectID(projects[0]?.id || '');
    }
  }, [projects, selectedProjectID]);

  const selectedProject = projects.find(project => project.id === selectedProjectID) || projects[0] || null;
  const effectiveCodeAgentID = preselectedCodeAgentID(snapshot.codeAgents, selectedProject, selectedCodeAgentID);
  const pathResult = pathCheck.path === cwd.trim() && !pathCheck.busy ? pathCheck.result : null;
  const validPath = Boolean(pathResult?.exists && pathResult.directory && pathResult.git_repo);
  const state = useMemo(
    () => firstDeliveryState({ ...snapshot, connectionTest: connectionCheck.result, projectConfirmed, projects, selectedCodeAgentID: effectiveCodeAgentID }),
    [connectionCheck.result, effectiveCodeAgentID, projectConfirmed, projects, snapshot],
  );
  const deliveryWorkID = state.targetWork?.id || '';
  useEffect(() => {
    if (!deliveryWorkID || state.completed) return undefined;
    let active = true;
    let pending = false;
    const timer = window.setInterval(async () => {
      if (pending || requestRef.current || document.visibilityState === 'hidden') return;
      pending = true;
      try {
        const delivery = await loadDeliverySnapshot(deliveryWorkID);
        if (active) setSnapshot(current => ({ ...current, ...delivery, targetWorkID: deliveryWorkID }));
      } catch (failure) {
        if (active) setError(failure.message || '交付状态暂未刷新，请重新检查');
      } finally { pending = false; }
    }, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [deliveryWorkID, state.completed]);
  const recovery = firstDeliveryRecovery(state);
  const steps = Object.fromEntries(state.steps.map(step => [step.id, step]));

  const actions = useFirstDeliveryActions({
    setSnapshot, setBusy, setError, setSelectedCodeAgentID, selectedCodeAgentID,
    selectedProject, state, projects, refreshData, setSelectedProjectID,
    setProjectConfirmed, validPath, pathResult, cwd, refreshCodexImport,
    selectedProjectID, targetWorkRef, onOpenWork, setCreationNeedsRefresh, recovery,
  });
  return {
    nodesById, codexImport, snapshot, loading, busy,
    error, cwd, setCwd, selectedProjectID, setSelectedProjectID,
    setSelectedCodeAgentID, pathCheck, setPathCheck, connectionCheck, connectionCheckRef,
    setConnectionCheck, creationNeedsRefresh, load, selectedProject, effectiveCodeAgentID,
    pathResult, validPath, state, recovery, steps,
    ...actions,
  };
}

async function loadDeliverySnapshot(workID) {
  const [response, evidencePage, handoffPage, runsPage] = await Promise.all([
    workApi.getWork(workID),
    evidenceApi.listEvidence({ limit: 100, status: 'passed', workId: workID }),
    handoffsApi.getHandoffs({ limit: 20, workId: workID }),
    runsApi.getRuns({ pageSize: 1, workId: workID }),
  ]);
  const work = response?.work || response;
  const candidates = handoffPage?.items || [];
  const latestRunID = runsPage?.items?.[0]?.id;
  const detail = candidates[0] ? await handoffsApi.getHandoff(candidates[0].id) : null;
  return {
    works: work?.id === workID ? [work] : [],
    evidence: evidencePage?.items || [],
    handoffs: detail?.handoff && latestRunID && detail.handoff.run_ids?.includes(latestRunID) ? [{ ...detail.handoff, evidence_count: detail.handoff.evidence_ids?.length || 0 }] : [],
  };
}
