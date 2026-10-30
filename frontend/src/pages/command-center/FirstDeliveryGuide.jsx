import { projectOptionLabel } from '../../utils/projectOptionLabel.js';

import { AlertTriangle, CheckCircle2, ChevronRight, Clipboard, Cpu, FolderPlus, Loader2, Monitor, RefreshCw, Rocket, Terminal } from 'lucide-react';

import { codexBackendChoices } from '../../utils/codexBackends.js';
import { readFirstDeliveryConnectionTest } from '../../utils/firstDeliveryConnection.js';
import { FIRST_DELIVERY_TITLE, RUNTIME_REPAIR_COMMAND } from './firstDeliveryGuideModel.js';
import { projectPathFeedback } from './firstDeliverySetup.js';
import OnboardingDeliveryReview from './OnboardingDeliveryReview.jsx';
import OnboardingSupervisorConnection from './OnboardingSupervisorConnection.jsx';
import { codexImportNote, codexImportVisible } from '../codexImportPreview.js';
import './FirstDeliveryGuide.css';

import { useFirstDeliveryGuideState } from './useFirstDeliveryGuideState.js';
const AGENT_DESCRIPTIONS = Object.freeze({
  codex: 'Codex CLI / Codex App',
  claude: 'Claude Code CLI / Agent SDK',
  'pi-coding-agent': 'Pi Coding Agent RPC',
  qoder: 'Qoder Agent SDK / qodercli',
});

export default function FirstDeliveryGuide({ checkSavedConnection, onComplete, onOpenWork, projects }) {
  const {
    nodesById, codexImport, snapshot, loading, busy,
    error, cwd, setCwd, selectedProjectID, setSelectedProjectID,
    setSelectedCodeAgentID, pathCheck, setPathCheck, connectionCheck, connectionCheckRef,
    setConnectionCheck, creationNeedsRefresh, load, selectedProject, effectiveCodeAgentID,
    pathResult, validPath, state, recovery, steps,
    selectCodeAgent, discoverCodeAgents, selectCodexBackend, confirmProject, createProject,
    importCodex, createSampleWork, copyRecovery,
  } = useFirstDeliveryGuideState({ checkSavedConnection, onOpenWork, projects });
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
                    {projects.map(project => <option key={project.id} value={project.id}>{projectOptionLabel(project, nodesById, project.name || project.id)}</option>)}
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
