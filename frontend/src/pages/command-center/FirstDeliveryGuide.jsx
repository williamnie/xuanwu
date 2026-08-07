import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, ChevronRight, Clipboard, FolderPlus, Loader2,
  RefreshCw, Rocket, Settings2,
} from 'lucide-react';
import { evidenceApi } from '../../api/evidence.js';
import { handoffsApi } from '../../api/handoffs.js';
import { projectsApi } from '../../api/projects.js';
import { systemApi } from '../../api/system.js';
import { workApi } from '../../api/work.js';
import { selectRefreshData, useDataStore } from '../../store/dataStore.js';
import { message } from '../../store/toastStore.js';
import { readFirstDeliveryConnectionTest } from '../../utils/firstDeliveryConnection.js';
import {
  FIRST_DELIVERY_TITLE,
  firstDeliveryRecovery,
  firstDeliveryState,
  onboardingProjectID,
  sampleWorkPayload,
} from './firstDeliveryGuideModel.js';
import './FirstDeliveryGuide.css';

const EMPTY_SNAPSHOT = { codeAgents: [], connectionTest: null, doctor: null, evidence: [], handoffs: [], works: [] };

export default function FirstDeliveryGuide({ navigateTo, projects }) {
  const refreshData = useDataStore(selectRefreshData);
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [cwd, setCwd] = useState('');
  const [selectedProjectID, setSelectedProjectID] = useState(projects[0]?.id || '');
  const [creationNeedsRefresh, setCreationNeedsRefresh] = useState(false);
  const requestRef = useRef(null);

  const load = useCallback(async () => {
    if (requestRef.current) return requestRef.current.promise;
    setLoading(true);
    const controller = new AbortController();
    const promise = Promise.all([
      systemApi.getRuntimeDoctor(),
      systemApi.getCodeAgents(),
      workApi.getWorks({ pageSize: 8 }, { signal: controller.signal }),
      handoffsApi.getHandoffs({ limit: 20 }),
    ]);
    requestRef.current = { controller, promise };
    try {
      const [doctor, codeAgentsResponse, worksPage, handoffPage] = await promise;
      const works = worksPage?.items || [];
      const handoffs = handoffPage?.items || [];
      const sample = works.find(work => work?.title === FIRST_DELIVERY_TITLE);
      const candidateWorkID = [
        sample?.id,
        ...handoffs.filter(item => item?.evidence_count > 0).map(item => item.work_id),
        works[0]?.id,
      ].find(Boolean);
      const evidencePage = candidateWorkID
        ? await evidenceApi.listEvidence({ limit: 10, status: 'passed', workId: candidateWorkID })
        : null;
      const evidence = evidencePage?.items || [];
      if (controller.signal.aborted) return;
      setSnapshot({
        codeAgents: Array.isArray(codeAgentsResponse?.agents) ? codeAgentsResponse.agents : [],
        connectionTest: readFirstDeliveryConnectionTest(),
        doctor,
        evidence,
        handoffs,
        works,
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
    return () => requestRef.current?.controller.abort();
  }, [load]);
  useEffect(() => {
    if (!projects.some(project => project.id === selectedProjectID)) {
      setSelectedProjectID(projects[0]?.id || '');
    }
  }, [projects, selectedProjectID]);

  const state = useMemo(
    () => firstDeliveryState({ ...snapshot, projects }),
    [projects, snapshot],
  );
  const recovery = firstDeliveryRecovery(state, snapshot.doctor);
  const steps = Object.fromEntries(state.steps.map(step => [step.id, step]));

  const createProject = async (event) => {
    event.preventDefault();
    const path = cwd.trim();
    if (!path) return setError('请输入本地仓库绝对路径');
    setBusy('project');
    setError('');
    try {
      const provider = state.availableCodeAgents[0]?.id || 'codex';
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
      await refreshData(['projects', 'issues']);
      setSelectedProjectID(id);
      message.success('项目已添加，并开启 Auto Run');
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
      if (!existing) await workApi.createWork(sampleWorkPayload(project.id));
      await projectsApi.startProjectLoop(project.id);
      message.success(existing ? '已恢复现有示例 Work 并启动 Loop' : '只读示例 Work 已创建并启动');
      await refreshData(['projects', 'issues']);
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
            <span className="first-delivery-kicker">10-MINUTE FIRST DELIVERY</span>
            <h2 id="first-delivery-title">{state.completed ? '首次交付已可证明' : '完成第一个可审查 Work'}</h2>
            <p>从 Agent、项目到 Evidence / Handoff；全程使用现有 authority，无需进入 Advanced。</p>
          </div>
        </div>
        <button className="first-delivery-refresh" disabled={loading || Boolean(busy)} onClick={load} type="button">
          <RefreshCw className={loading ? 'spin-animation' : ''} size={14} /> 重新检查
        </button>
      </header>

      <div className="first-delivery-checklist">
        {state.steps.map((step, index) => (
          <div className={`first-delivery-step ${step.complete ? 'done' : index === state.currentStep ? 'current' : ''}`} key={step.id}>
            <span>{step.complete ? <CheckCircle2 size={15} /> : index + 1}</span>
            <strong>{step.label}</strong>
          </div>
        ))}
      </div>

      {error ? <div className="first-delivery-error" role="alert"><AlertTriangle size={15} /> {error}</div> : null}
      {!state.completed ? (
        <div className="first-delivery-actions">
          {!steps['code-agent'].complete ? (
            <ActionCard title="选择 Code Agent" description="启用一个可执行的 Agent；Codex 可明确选择 CLI 或 App app-server。">
              <button className="btn btn-primary" onClick={() => navigateTo('settings', null, '', '', { settingsSection: 'code-agents' })} type="button"><Settings2 size={14} /> 打开 Code Agents</button>
            </ActionCard>
          ) : null}
          {steps['code-agent'].complete && !steps.supervisor.complete ? (
            <ActionCard title="配置玄武" description="在设置 → Xuanwu Supervisor 中选择 Provider、测试连接并保存。">
              <button className="btn btn-primary" onClick={() => navigateTo('settings', null, '', '', { settingsSection: 'supervisor' })} type="button"><Settings2 size={14} /> 打开 Supervisor 设置</button>
            </ActionCard>
          ) : null}
          {steps.supervisor.complete && !steps.project.complete ? (
            <ActionCard title="添加第一个项目" description="路径必须是 Runner 所在机器上已存在的目录。">
              <form className="first-delivery-project-form" onSubmit={createProject}>
                <input aria-label="本地项目绝对路径" className="form-control" onChange={event => setCwd(event.target.value)} placeholder="/absolute/path/to/repository" value={cwd} />
                <button className="btn btn-primary" disabled={busy === 'project'} type="submit">
                  {busy === 'project' ? <Loader2 className="spin-animation" size={14} /> : <FolderPlus size={14} />} 添加并启用
                </button>
              </form>
            </ActionCard>
          ) : null}
          {steps.project.complete && !steps.work.complete ? (
            <ActionCard title="运行只读示例 Work" description="只检查 README / manifest / Git 状态，不改文件、不 commit、不对外写入。">
              <div className="first-delivery-work-action">
                <select aria-label="示例 Work 项目" className="form-control" onChange={event => setSelectedProjectID(event.target.value)} value={selectedProjectID || projects[0]?.id || ''}>
                  {projects.map(project => <option key={project.id} value={project.id}>{project.name || project.id}</option>)}
                </select>
                <button className="btn btn-primary" disabled={busy === 'work' || creationNeedsRefresh} onClick={createSampleWork} type="button">
                  {busy === 'work' ? <Loader2 className="spin-animation" size={14} /> : <Rocket size={14} />} 创建并开始
                </button>
              </div>
            </ActionCard>
          ) : null}
          {steps.work.complete ? (
            <ActionCard title={state.targetWork?.title || '首个 Work'} description={`${state.targetWork?.id || ''} · ${state.targetWork?.status || 'unknown'}`}>
              <button className="btn btn-secondary" onClick={() => navigateTo('work', state.targetWork?.id)} type="button">打开 Work <ChevronRight size={14} /></button>
            </ActionCard>
          ) : null}
        </div>
      ) : null}

      <div className={`first-delivery-recovery ${state.completed ? 'success' : ''}`}>
        <div>
          <strong>{state.completed ? '成功清单已通过' : '失败恢复'}</strong>
          <p>{state.completed ? `${state.targetWork?.id} 已有 ${state.targetEvidence.length} 条 passed Evidence 和同 Work Handoff。` : recovery}</p>
        </div>
        {!state.completed ? <button aria-label="复制恢复步骤" onClick={copyRecovery} type="button"><Clipboard size={14} /> 复制</button> : null}
      </div>
    </section>
  );
}

function ActionCard({ children, description, title }) {
  return <div className="first-delivery-action-card"><div><strong>{title}</strong><p>{description}</p></div><div>{children}</div></div>;
}
