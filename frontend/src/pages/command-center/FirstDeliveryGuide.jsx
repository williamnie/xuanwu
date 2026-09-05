import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, ChevronRight, Clipboard, Cpu, FolderPlus, Loader2,
  Monitor, RefreshCw, Rocket, Terminal,
} from 'lucide-react';
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
import { readFirstDeliveryConnectionTest } from '../../utils/firstDeliveryConnection.js';
import {
  FIRST_DELIVERY_TITLE,
  firstDeliveryRecovery,
  firstDeliveryState,
  onboardingProjectID,
  sampleWorkPayload,
} from './firstDeliveryGuideModel.js';
import OnboardingDeliveryReview from './OnboardingDeliveryReview.jsx';
import OnboardingSupervisorConnection from './OnboardingSupervisorConnection.jsx';
import './FirstDeliveryGuide.css';

const EMPTY_SNAPSHOT = { codeAgents: [], connectionTest: null, doctor: null, evidence: [], handoffs: [], runnerSettings: null, works: [] };
const AGENT_DESCRIPTIONS = Object.freeze({
  codex: 'Codex CLI / Codex App',
  claude: 'Claude Code CLI / Agent SDK',
  'pi-coding-agent': 'Pi Coding Agent RPC',
  qoder: 'Qoder Agent SDK / qodercli',
});

export default function FirstDeliveryGuide({ onComplete, projects }) {
  const refreshData = useDataStore(selectRefreshData);
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [cwd, setCwd] = useState('');
  const [selectedCodeAgentID, setSelectedCodeAgentID] = useState('');
  const [selectedProjectID, setSelectedProjectID] = useState(projects[0]?.id || '');
  const [creationNeedsRefresh, setCreationNeedsRefresh] = useState(false);
  const requestRef = useRef(null);
  const targetWorkRef = useRef('');

  const load = useCallback(async () => {
    if (requestRef.current) return requestRef.current.promise;
    setLoading(true);
    const controller = new AbortController();
    const promise = Promise.all([
      systemApi.getRuntimeDoctor(),
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
        connectionTest: readFirstDeliveryConnectionTest(),
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
  const effectiveCodeAgentID = selectedCodeAgentID || selectedProject?.provider || '';
  const state = useMemo(
    () => firstDeliveryState({ ...snapshot, projects, selectedCodeAgentID: effectiveCodeAgentID }),
    [effectiveCodeAgentID, projects, snapshot],
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
  const recovery = firstDeliveryRecovery(state, snapshot.doctor);
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
      if (selectedProject && selectedProject.provider !== agent.id) {
        await projectsApi.updateProject(selectedProject.id, {
          default_agent_profile_id: '',
          model: agent.id === 'codex' ? 'codex-default' : '',
          provider: agent.id,
        });
        await refreshData(['projects', 'workSummary']);
      }
      setSelectedCodeAgentID(agent.id);
      message.success(`${enabled.label || agent.id} 已选中${selectedProject ? '并绑定当前项目' : ''}`);
    } catch (agentError) {
      setError(agentError.message || '启用 Code Agent 失败');
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
      setError(agentError.message || '重新发现 Code Agents 失败');
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
        if (selectedProject && selectedProject.provider !== 'codex') {
          await projectsApi.updateProject(selectedProject.id, { default_agent_profile_id: '', model: 'codex-default', provider: 'codex' });
          await refreshData(['projects', 'workSummary']);
        }
        setSelectedCodeAgentID('codex');
      } else setSelectedCodeAgentID('');
      if (runnerSettings?.runtime_apply?.codexTransport === 'deferred_active_sessions') {
        message.warning('Codex 后端已保存；当前 Session 结束或服务重启后生效');
      } else {
        message.success(`新的 Codex 任务将使用 ${mode === 'app' ? 'Codex App' : 'Codex CLI'}`);
      }
    } catch (agentError) {
      setError(agentError.message || '切换 Codex 后端失败');
    } finally {
      setBusy('');
    }
  };

  const createProject = async (event) => {
    event.preventDefault();
    const path = cwd.trim();
    if (!path) return setError('请输入本地仓库绝对路径');
    if (!state.selectedCodeAgent) return setError('请先选择可用的 Code Agent');
    setBusy('project');
    setError('');
    try {
      const provider = state.selectedCodeAgent.id;
      const id = onboardingProjectID(path);
      await projectsApi.createProject({
        approval_policy: 'never',
        auto_run: 1,
        cwd: path,
        id,
        model: provider === 'codex' ? 'codex-default' : '',
        name: path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || id,
        provider,
        sandbox: 'workspace-write',
      });
      await refreshData(['projects', 'workSummary']);
      setSelectedProjectID(id);
      message.success(`项目已添加，并绑定 ${state.selectedCodeAgent.label || provider}`);
      await load();
    } catch (createError) {
      setError(createError.message || '添加项目失败');
    } finally {
      setBusy('');
    }
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
      message.success(existing ? '已恢复现有示例 Work 并启动 Loop' : '示例 Work 已创建并启动');
      await refreshData(['projects', 'workSummary']);
      await load();
    } catch (createError) {
      setCreationNeedsRefresh(true);
      setError(`${createError.message || '创建示例 Work 失败'}。为避免重复创建，请先重新检查。`);
    } finally {
      setBusy('');
    }
  };

  const copyRecovery = async () => {
    try {
      await navigator.clipboard.writeText(recovery);
      message.success('恢复步骤已复制');
    } catch (copyError) {
      setError(copyError.message || '复制失败，请手动选中恢复步骤');
    }
  };

  return (
    <section className={`first-delivery-guide ${state.completed ? 'completed' : ''}`} aria-labelledby="first-delivery-title">
      <header className="first-delivery-header">
        <div className="first-delivery-heading">
          <span className="first-delivery-icon"><Rocket size={19} /></span>
          <div>
            <span className="first-delivery-kicker">FIRST SETUP</span>
            <h2 id="first-delivery-title">{state.completed ? '玄武可以开始工作了' : '先完成一次配置'}</h2>
            <p>配好 Code Agent、Supervisor 和项目，之后就可以直接把 Issue 交给玄武。</p>
          </div>
        </div>
        <button className="first-delivery-refresh" disabled={loading || Boolean(busy)} onClick={load} type="button">
          <RefreshCw className={loading ? 'spin-animation' : ''} size={14} /> 重新检查
        </button>
      </header>

      <div className="first-delivery-checklist" aria-label="首次配置进度">
        {state.steps.map((step, index) => (
          <div aria-current={index === state.currentStep ? 'step' : undefined} aria-label={`${step.label}：${step.complete ? '已完成' : index === state.currentStep ? '当前步骤' : '未完成'}`} className={`first-delivery-step ${step.complete ? 'done' : index === state.currentStep ? 'current' : ''}`} key={step.id}>
            <span>{step.complete ? <CheckCircle2 size={15} /> : index + 1}</span>
            <strong>{step.label}</strong>
          </div>
        ))}
      </div>

      {error ? <div className="first-delivery-error" role="alert"><AlertTriangle size={15} /> {error}</div> : null}
      {loading && !snapshot.doctor ? <div className="first-delivery-inline-loading"><Loader2 className="spin-animation" size={14} /> 正在读取首次配置状态…</div> : null}
      {!state.completed && snapshot.doctor ? (
        <div className="first-delivery-actions">
          {!steps.runtime.complete ? (
            <ActionCard description="Service 或 Database 未通过检查；修复后在原地重新读取状态。" title="确认运行环境">
              <button className="btn btn-primary" disabled={loading} onClick={load} type="button"><RefreshCw size={14} /> 重新检查</button>
            </ActionCard>
          ) : !steps['code-agent'].complete ? (
            <ActionCard description="选择实际执行 Issue 的 Code Agent；未配置的执行器不会被静默选中。" title="选择 Code Agent" wide>
              <CodeAgentPicker
                agents={snapshot.codeAgents}
                busy={busy}
                codexChoices={codexBackendChoices(snapshot.runnerSettings || {})}
                onDiscover={discoverCodeAgents}
                onSelect={selectCodeAgent}
                onSelectCodexBackend={selectCodexBackend}
                selectedID={selectedCodeAgentID}
              />
            </ActionCard>
          ) : !steps.supervisor.complete ? (
            <ActionCard description="只展示两类兼容 API 与 Codex OAuth；其他协议保留在高级设置。" title="连接 Supervisor" wide>
              <OnboardingSupervisorConnection onComplete={load} />
            </ActionCard>
          ) : !steps.project.complete ? (
            <ActionCard description={`路径必须存在于 Runner 所在机器；新项目将绑定 ${state.selectedCodeAgent?.label || state.selectedCodeAgent?.id}。`} title="添加第一个项目">
              <form className="first-delivery-project-form" onSubmit={createProject}>
                <input aria-label="本地项目绝对路径" className="form-control" onChange={event => setCwd(event.target.value)} placeholder="/absolute/path/to/repository" value={cwd} />
                <button className="btn btn-primary" disabled={busy === 'project'} type="submit">
                  {busy === 'project' ? <Loader2 className="spin-animation" size={14} /> : <FolderPlus size={14} />} 添加并启用
                </button>
              </form>
            </ActionCard>
          ) : !steps.work.complete ? (
            <ActionCard description="玄武会创建一个测试 Issue，让 Code Agent 真正执行一次；不会修改项目代码。" title="启动第一个 Issue" wide>
              <div className="first-delivery-work-panel">
                <code><span>$</span> printf 'Hello Xuanwu\n'</code>
                <ul>
                  <li><CheckCircle2 size={13} /> 玄武创建并启动 Issue</li>
                  <li><CheckCircle2 size={13} /> Code Agent 实际执行一次</li>
                  <li><CheckCircle2 size={13} /> 做完后回到这里看结果</li>
                </ul>
                <div className="first-delivery-work-action">
                  <select aria-label="示例 Work 项目" className="form-control" onChange={event => setSelectedProjectID(event.target.value)} value={selectedProjectID || projects[0]?.id || ''}>
                    {projects.map(project => <option key={project.id} value={project.id}>{project.name || project.id}</option>)}
                  </select>
                  <button className="btn btn-primary" disabled={busy === 'work' || creationNeedsRefresh} onClick={createSampleWork} type="button">
                    {busy === 'work' ? <Loader2 className="spin-animation" size={14} /> : <Rocket size={14} />} 创建并开始
                  </button>
                </div>
              </div>
            </ActionCard>
          ) : (
            <ActionCard wide description={`${state.targetWork?.id || ''} · ${state.targetWork?.status || 'unknown'}`} title={state.targetWork?.title || '首个 Work'}>
              <button className="btn btn-secondary" disabled={loading} onClick={load} type="button"><RefreshCw className={loading ? 'spin-animation' : ''} size={14} /> 刷新交付状态</button>
            </ActionCard>
          )}
        </div>
      ) : null}

      {state.targetWork && !state.completed && ['done', 'failed', 'needs_user'].includes(state.targetWork.status) ? (
        <OnboardingDeliveryReview key={state.targetWork.id} onRefresh={load} work={state.targetWork} />
      ) : null}

      <div className={`first-delivery-recovery ${state.completed ? 'success' : ''}`}>
        <div>
          <strong>{state.completed ? '第一次执行完成' : '这一步的恢复方式'}</strong>
          <p>{state.completed ? `${state.targetWork?.title || '测试 Issue'} 已完成，可以进入指挥中心查看结果。` : recovery}</p>
        </div>
        {state.completed ? (
          <button className="first-delivery-complete" onClick={onComplete} type="button">进入指挥中心 <ChevronRight size={14} /></button>
        ) : <button aria-label="复制恢复步骤" onClick={copyRecovery} type="button"><Clipboard size={14} /> 复制</button>}
      </div>
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
