import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, ChevronRight, Clipboard, Cpu, FolderPlus, Loader2,
  Monitor, RefreshCw, Rocket, Terminal,
} from 'lucide-react';
import { assistantApi } from '../../api/assistant.js';
import { evidenceApi } from '../../api/evidence.js';
import { firstDeliveryApi } from '../../api/firstDelivery.js';
import { handoffsApi } from '../../api/handoffs.js';
import { runsApi } from '../../api/runs.js';
import { projectsApi } from '../../api/projects.js';
import { systemApi } from '../../api/system.js';
import { workApi } from '../../api/work.js';
import { selectRefreshData, useDataStore } from '../../store/dataStore.js';
import { message } from '../../store/toastStore.js';
import { codexBackendChoices, codexBackendUpdatePayload } from '../../utils/codexBackends.js';
import { readFirstDeliveryConnectionTest, recordFirstDeliveryConnectionTest } from '../../utils/firstDeliveryConnection.js';
import {
  FIRST_DELIVERY_TITLE,
  firstDeliveryRecovery,
  firstDeliveryState,
  preselectedCodeAgentID,
  RUNTIME_REPAIR_COMMAND,
  sampleWorkPayload,
} from './firstDeliveryGuideModel.js';
import { codexImportFailure, createFirstDeliveryConnectionCheck, projectPathFeedback } from './firstDeliverySetup.js';
import OnboardingDeliveryReview from './OnboardingDeliveryReview.jsx';
import OnboardingSupervisorConnection from './OnboardingSupervisorConnection.jsx';
import { codexImportNote, codexImportVisible, useCodexImportPreview } from '../codexImportPreview.js';
import './FirstDeliveryGuide.css';

const EMPTY_SNAPSHOT = { codeAgents: [], connectionTest: null, doctor: null, evidence: [], handoffs: [], runnerSettings: null, works: [] };
const AGENT_DESCRIPTIONS = Object.freeze({
  codex: 'Codex CLI / Codex App',
  claude: 'Claude Code CLI / Agent SDK',
  'pi-coding-agent': 'Pi Coding Agent RPC',
  qoder: 'Qoder Agent SDK / qodercli',
});

export default function FirstDeliveryGuide({ checkSavedConnection, onComplete, onOpenWork, projects }) {
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

  const updateCodeAgents = (response) => {
    const codeAgents = Array.isArray(response?.agents) ? response.agents : [];
    setSnapshot(current => ({ ...current, codeAgents }));
    return codeAgents;
  };

  const selectCodeAgent = async (agent) => {
    if (agent.enabled && !agent.submittable) return setError(agent.readiness_reason || `${agent.label || agent.id} 尚未就绪`);
    setBusy(`agent:${agent.id}`);
    setError('');
    try {
      let enabled = agent;
      if (!agent.enabled) {
        const agents = updateCodeAgents(await systemApi.updateCodeAgent(agent.id, true));
        enabled = agents.find(item => item.id === agent.id);
      }
      if (!enabled?.submittable) return setError(enabled?.readiness_reason || `${enabled?.label || agent.id} 已启用，但尚未就绪`);
      setSelectedCodeAgentID(agent.id);
      message.success(`${enabled.label || agent.id} 已选中，确认项目后绑定`);
    } catch (agentError) {
      setError(agentError.message || '启用编程工具失败');
    } finally {
      setBusy('');
    }
  };

  const discoverCodeAgents = async () => {
    setBusy('agent:discover');
    setError('');
    try {
      const agents = updateCodeAgents(await systemApi.discoverCodeAgents());
      if (selectedCodeAgentID && !agents.some(agent => agent.id === selectedCodeAgentID && agent.enabled && agent.submittable)) {
        setSelectedCodeAgentID('');
      }
    } catch (agentError) {
      setError(agentError.message || '重新发现编程工具失败');
    } finally {
      setBusy('');
    }
  };

  const selectCodexBackend = async (mode) => {
    setBusy('agent:codex-backend');
    setError('');
    try {
      const runnerSettings = await systemApi.updateRunnerSettings(codexBackendUpdatePayload(mode));
      const agents = updateCodeAgents(await systemApi.discoverCodeAgents());
      setSnapshot(current => ({ ...current, runnerSettings }));
      if (agents.some(agent => agent.id === 'codex' && agent.enabled && agent.submittable)) {
        setSelectedCodeAgentID('codex');
      } else setSelectedCodeAgentID('');
      if (runnerSettings?.runtime_apply?.codexTransport === 'deferred_active_sessions') {
        message.warning('Codex 后端已保存；当前执行记录结束或服务重启后生效');
      } else {
        message.success(`新的 Codex 任务将使用 ${mode === 'app' ? 'Codex App' : 'Codex CLI'}`);
      }
    } catch (agentError) {
      setError(agentError.message || '切换 Codex 后端失败');
    } finally {
      setBusy('');
    }
  };

  const confirmProject = async (project = selectedProject) => {
    if (!project || !state.selectedCodeAgent) return;
    setBusy('project');
    setError('');
    try {
      // Preselection is local; only this explicit confirmation binds the tool.
      if (project.provider !== state.selectedCodeAgent.id) {
        await projectsApi.updateProject(project.id, {
          default_agent_profile_id: '',
          model: state.selectedCodeAgent.id === 'codex' ? 'codex-default' : '',
          provider: state.selectedCodeAgent.id,
        });
      }
      if (project.provider !== state.selectedCodeAgent.id || !projects.some(item => item.id === project.id)) {
        await refreshData(['projects', 'workSummary']);
      }
      setSelectedProjectID(project.id);
      setProjectConfirmed(true);
    } catch (failure) {
      setError(failure.message || '项目绑定失败，请重试');
    } finally { setBusy(''); }
  };

  const createProject = async (event) => {
    event.preventDefault();
    if (!validPath) return setError('请等待项目路径检查通过');
    if (!state.selectedCodeAgent) return setError('请先选择可用的编程工具');
    setBusy('project');
    setError('');
    try {
      if (pathResult.existing_project_id) {
        const existing = projects.find(project => project.id === pathResult.existing_project_id)
          || await projectsApi.getProject(pathResult.existing_project_id);
        return await confirmProject(existing);
      }
      const provider = state.selectedCodeAgent.id;
      const path = cwd.trim();
      const created = await projectsApi.createProject({
        approval_policy: 'never',
        auto_run: 1,
        cwd: path,
        id: pathResult.suggested_id,
        model: provider === 'codex' ? 'codex-default' : '',
        name: path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || pathResult.suggested_id,
        provider,
        sandbox: 'workspace-write',
      });
      await refreshData(['projects', 'workSummary']);
      setSelectedProjectID(created.id);
      setProjectConfirmed(true);
      message.success(`项目已添加，并绑定 ${state.selectedCodeAgent.label || provider}`);
    } catch (createError) {
      setError(createError.message || '添加项目失败');
    } finally { setBusy(''); }
  };

  const importCodex = async () => {
    setBusy('import');
    setError('');
    try {
      const result = await projectsApi.syncCodexProjects();
      await Promise.all([refreshData(['projects', 'workSummary']), refreshCodexImport()]);
      const project = result.created?.[0] || result.existing?.[0];
      if (project) setSelectedProjectID(project.id);
      message.success(project ? '工作区已导入，请确认要使用的项目' : '没有可导入的本机工作区，请直接输入项目路径');
    } catch (failure) { setError(codexImportFailure(failure)); }
    finally { setBusy(''); }
  };

  const createSampleWork = async () => {
    const project = projects.find(item => item.id === selectedProjectID) || projects[0];
    if (!project) return setError('请先添加项目');
    setBusy('work');
    setError('');
    try {
      const authority = await workApi.getWorks({
        pageSize: 10,
        projectId: project.id,
        query: FIRST_DELIVERY_TITLE,
      });
      const existing = (authority?.items || []).find(work => work?.title === FIRST_DELIVERY_TITLE);
      const created = existing || await workApi.createWork(sampleWorkPayload(project.id));
      targetWorkRef.current = created?.work?.id || created?.id || existing?.id || '';
      await firstDeliveryApi.startProjectLoop(project.id);
      message.success(existing ? '已恢复现有示例任务' : '示例任务已创建并开始');
      await refreshData(['projects', 'workSummary']);
      if (!targetWorkRef.current) throw new Error('未能读取示例任务，请重新检查');
      onOpenWork(targetWorkRef.current);
    } catch (createError) {
      setCreationNeedsRefresh(true);
      setError(`${createError.message || '创建示例任务失败'}。为避免重复创建，请先重新检查。`);
    } finally {
      setBusy('');
    }
  };

  const copyRecovery = async () => {
    try {
      await navigator.clipboard.writeText(!state.runtimeReady ? RUNTIME_REPAIR_COMMAND : recovery);
      message.success('恢复步骤已复制');
    } catch (copyError) {
      setError(copyError.message || '复制失败，请手动选中恢复步骤');
    }
  };

  return (
    <section className={`first-delivery-guide ${state.completed ? 'completed' : ''}`} aria-labelledby="first-delivery-title">
      <header className="first-delivery-header">
        <div className="first-delivery-heading">
          <span className="first-delivery-icon"><Rocket size={16} /></span>
          <div>
            <span className="first-delivery-kicker">FIRST SETUP</span>
            <h2 id="first-delivery-title">{state.completed ? '第一次交付完成了' : '三步开始第一个任务'}</h2>
            <p>准备编程工具和玄武助手，选好项目，就可以开始。</p>
          </div>
        </div>
        <button className="first-delivery-refresh" disabled={loading || Boolean(busy)} onClick={load} type="button">
          <RefreshCw className={loading ? 'spin-animation' : ''} size={14} /> 重新检查
        </button>
      </header>

      <div className={`first-delivery-checklist${steps.runtime ? ' runtime-failed' : ''}`} aria-label="首次配置进度">
        {state.steps.map((step, index) => (
          <div aria-current={index === state.currentStep ? 'step' : undefined} aria-label={`${step.label}：${step.complete ? '已完成' : index === state.currentStep ? '当前步骤' : '未完成'}`} className={`first-delivery-step ${step.complete ? 'done' : index === state.currentStep ? 'current' : ''}`} key={step.id}>
            <span>{step.complete ? <CheckCircle2 size={15} /> : index + 1}</span>
            <strong>{step.label}</strong>
          </div>
        ))}
      </div>

      {error ? <div className="first-delivery-error" role="alert"><AlertTriangle size={15} /> {error}</div> : null}
      {loading && !snapshot.doctor ? <div className="first-delivery-inline-loading"><Loader2 className="spin-animation" size={14} /> 正在后台检查运行环境…</div> : null}
      {!state.completed && snapshot.doctor ? (
        <div className="first-delivery-actions">
          {steps.runtime ? (
            <ActionCard description="可复制下方重启与检查命令，在运行玄武的机器上执行；本页不会自动执行命令。" title="修复运行环境">
              <button className="btn btn-primary" disabled={loading} onClick={load} type="button"><RefreshCw size={14} /> 重新检查</button>
            </ActionCard>
          ) : !steps.ai.complete ? (
            <ActionCard description="已就绪的编程工具会自动预选；确认项目时才会绑定。玄武助手负责执行后的自动验收。" title="准备 AI" wide>
              <CodeAgentPicker agents={snapshot.codeAgents} busy={busy} codexChoices={codexBackendChoices(snapshot.runnerSettings || {})} onDiscover={discoverCodeAgents} onSelect={selectCodeAgent} onSelectCodexBackend={selectCodexBackend} selectedID={effectiveCodeAgentID} />
              {connectionCheck.busy ? <p className="first-delivery-inline-loading" role="status"><Loader2 className="spin-animation" size={14} /> 正在检查已保存的玄武助手连接…</p> : state.supervisorReady ? <p className="first-delivery-flow-note">玄武助手连接通过，已跳过连接配置。</p> : <>
                {connectionCheck.result?.ok === false ? <p className="first-delivery-flow-note" role="status">已保存的连接未通过检查，请核对连接信息后手动测试。</p> : null}
                <OnboardingSupervisorConnection onComplete={async () => {
                  const result = readFirstDeliveryConnectionTest();
                  connectionCheckRef.current.remember(result);
                  setConnectionCheck({ busy: false, result });
                }} />
              </>}
            </ActionCard>
          ) : !steps.project.complete ? (
            <ActionCard description={`已预选 ${state.selectedCodeAgent?.label || state.selectedCodeAgent?.id}；确认项目后绑定。路径应位于运行玄武的机器上。`} title="选项目文件夹" wide>
              <div className="first-delivery-project-panel">
                {projects.length ? <div className="first-delivery-work-action">
                  <select aria-label="已有项目" className="form-control" onChange={event => { setSelectedProjectID(event.target.value); setSelectedCodeAgentID(''); }} value={selectedProjectID}>
                    {projects.map(project => <option key={project.id} value={project.id}>{project.name || project.id}</option>)}
                  </select>
                  <button className="btn btn-primary" disabled={Boolean(busy)} onClick={() => confirmProject()} type="button">使用此项目</button>
                </div> : null}
                <form className="first-delivery-project-form" onSubmit={createProject}>
                  <input aria-label="本地项目绝对路径" aria-describedby="first-delivery-path-result" className="form-control" onChange={event => { setCwd(event.target.value); setPathCheck({ path: '', result: null, busy: false, error: '' }); }} placeholder="/absolute/path/to/repository" value={cwd} />
                  <button className={`btn ${projects.length ? 'btn-secondary' : 'btn-primary'}`} disabled={Boolean(busy) || !validPath} type="submit">
                    {busy === 'project' ? <Loader2 className="spin-animation" size={14} /> : <FolderPlus size={14} />} {pathResult?.existing_project_id ? '使用已有项目' : '添加并继续'}
                  </button>
                </form>
                <p className="first-delivery-flow-note" id="first-delivery-path-result" role="status">{!cwd.trim() ? '粘贴项目路径后自动检查，不会创建项目或执行命令。' : pathCheck.path !== cwd.trim() || pathCheck.busy ? '正在检查路径…' : pathCheck.error || projectPathFeedback(pathResult)}</p>
                {codexImportVisible(codexImport) ? <div className="first-delivery-import">
                  <button className="btn btn-secondary" disabled={Boolean(busy)} onClick={importCodex} type="button">从 Codex 导入</button>
                  <p className="first-delivery-flow-note">{codexImportNote(codexImport)}</p>
                </div> : null}
              </div>
            </ActionCard>
          ) : !state.targetWork ? (
            <ActionCard description="预填的示例任务只读取项目、执行验证，不修改项目代码。开始后进入任务详情实时查看。" title="开始第一个任务" wide>
              <div className="first-delivery-work-panel">
                <strong>{FIRST_DELIVERY_TITLE}</strong>
                <code><span>$</span> printf 'Hello Xuanwu\n'</code>
                <ul>
                  <li><CheckCircle2 size={13} /> 输出问候语并验证结果</li>
                  <li><CheckCircle2 size={13} /> 只读检查项目说明、依赖和 Git 状态</li>
                  <li><CheckCircle2 size={13} /> 汇报项目用途、验证结果和下一步建议</li>
                </ul>
                <div className="first-delivery-work-action">
                  <span>{selectedProject?.name || selectedProject?.id}</span>
                  <button className="btn btn-primary" disabled={busy === 'work' || creationNeedsRefresh} onClick={createSampleWork} type="button">
                    {busy === 'work' ? <Loader2 className="spin-animation" size={14} /> : <Rocket size={14} />} 开始
                  </button>
                </div>
              </div>
            </ActionCard>
          ) : (
            <ActionCard wide description="查看执行过程与验证结果；完成条件仍是任务完成、验证通过并产生交付结果。" title={state.targetWork.title || '首个任务'}>
              <button className="btn btn-secondary" onClick={() => onOpenWork(state.targetWork.id)} type="button">查看任务详情 <ChevronRight size={14} /></button>
            </ActionCard>
          )}
        </div>
      ) : null}

      {state.targetWork && !state.completed && state.runtimeReady && steps.ai.complete && ['done', 'failed', 'needs_user'].includes(state.targetWork.status) ? <OnboardingDeliveryReview key={state.targetWork.id} onRefresh={load} work={state.targetWork} /> : null}

      {snapshot.doctor ? <div className={`first-delivery-recovery ${state.completed ? 'success' : ''}`}>
        <div>
          <strong>{state.completed ? '第一次执行完成' : '下一步'}</strong>
          <p>{state.completed ? `${state.targetWork?.title || '示例任务'} 已完成，可以进入首页查看结果。` : recovery}</p>
          {!state.runtimeReady ? <pre><code>{RUNTIME_REPAIR_COMMAND}</code></pre> : null}
        </div>
        {state.completed ? <button className="first-delivery-complete" onClick={onComplete} type="button">进入首页 <ChevronRight size={14} /></button> : <button aria-label={!state.runtimeReady ? '复制修复命令' : '复制恢复步骤'} onClick={copyRecovery} type="button"><Clipboard size={14} /> 复制</button>}
      </div> : null}
    </section>
  );
}

function ActionCard({ children, description, title, wide = false }) {
  return <div className={`first-delivery-action-card${wide ? ' wide' : ''}`}><div><strong>{title}</strong><p>{description}</p></div><div>{children}</div></div>;
}

function CodeAgentPicker({ agents, busy, codexChoices, onDiscover, onSelect, onSelectCodexBackend, selectedID }) {
  return (
    <div className="first-delivery-agent-picker">
      <div className="first-delivery-agent-list">
        {agents.map(agent => {
          const ready = agent.enabled && agent.submittable;
          const selected = ready && selectedID === agent.id;
          const agentBusy = busy === `agent:${agent.id}`;
          return (
            <button
              aria-pressed={selected}
              className={selected ? 'selected' : ''}
              disabled={Boolean(busy) || (agent.enabled && !agent.submittable)}
              key={agent.id}
              onClick={() => onSelect(agent)}
              type="button"
            >
              <span className="first-delivery-agent-icon"><Cpu size={15} /></span>
              <span><strong>{agent.label || agent.id}</strong><small>{AGENT_DESCRIPTIONS[agent.id] || agent.id}</small></span>
              <em className={ready ? 'ready' : ''}>{agentBusy ? '处理中' : selected ? '已选择' : ready ? '可用' : agent.enabled ? '未就绪' : '启用'}</em>
            </button>
          );
        })}
      </div>
      {agents.some(agent => agent.id === 'codex' && agent.enabled && agent.submittable) ? (
        <div className="first-delivery-codex-backends">
          <span>CODEX APP-SERVER</span>
          <div>
            {codexChoices.map(choice => (
              <button aria-pressed={choice.active} className={choice.active ? 'active' : ''} disabled={Boolean(busy) || !choice.status.ready} key={choice.id} onClick={() => onSelectCodexBackend(choice.id)} type="button">
                {choice.id === 'app' ? <Monitor size={14} /> : <Terminal size={14} />}
                <span><strong>{choice.label}</strong><small>{choice.status.ready ? choice.status.detail : `未就绪 · ${choice.status.detail}`}</small></span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <button className="btn btn-secondary first-delivery-discover" disabled={Boolean(busy)} onClick={onDiscover} type="button">
        <RefreshCw className={busy === 'agent:discover' ? 'spin-animation' : ''} size={14} /> 重新发现
      </button>
    </div>
  );
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
