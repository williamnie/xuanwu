export const FIRST_DELIVERY_TITLE = '玄武首次交付：只读项目体检';

export function firstDeliveryState({ codeAgents = [], connectionTest = null, doctor, evidence = [], handoffs = [], projects = [], selectedCodeAgentID = '', projectConfirmed = false, targetWorkID = '', works = [] } = {}) {
  const runtimeReady = Boolean(doctor?.service?.alive && doctor?.db?.ok);
  const availableCodeAgents = (Array.isArray(codeAgents) ? codeAgents : [])
    .filter(agent => agent?.enabled !== false && agent?.submittable === true);
  const workByID = new Map(works.map(work => [work?.id, work]));
  const passedEvidenceWorkIDs = new Set(
    evidence.filter(item => item?.status === 'passed').map(item => item?.work_id).filter(Boolean),
  );
  const deliveredHandoff = handoffs.find(item => (
    item?.evidence_count > 0
    && passedEvidenceWorkIDs.has(item.work_id)
    && workByID.has(item.work_id)
  ));
  const sampleWork = works.find(work => work?.title === FIRST_DELIVERY_TITLE);
  const targetWork = targetWorkID ? workByID.get(targetWorkID) || null
    : sampleWork || (deliveredHandoff ? workByID.get(deliveredHandoff.work_id) : works[0]) || null;
  const targetEvidence = targetWork
    ? evidence.filter(item => item?.work_id === targetWork.id && item?.status === 'passed')
    : [];
  const targetHandoff = targetWork
    ? handoffs.find(item => item?.work_id === targetWork.id
      && ['ready', 'delivered'].includes(item.status)
      && item.evidence_ids?.some(id => targetEvidence.some(evidence => evidence.id === id))) || null
    : null;
  const deliveryReady = Boolean(
    targetWork?.status === 'done'
    && targetEvidence.length > 0
    && targetHandoff,
  );
  const selectedCodeAgent = availableCodeAgents.find(agent => agent.id === selectedCodeAgentID) || null;
  const codeAgentReady = Boolean(selectedCodeAgent || deliveryReady);
  const supervisorReady = connectionTest?.ok === true;

  const steps = [
    ...(doctor && !runtimeReady ? [{ id: 'runtime', complete: false, label: '修复运行环境' }] : []),
    { id: 'ai', complete: (codeAgentReady && supervisorReady) || deliveryReady, label: '准备 AI' },
    { id: 'project', complete: (projects.length > 0 && projectConfirmed) || Boolean(targetWork), label: '选项目文件夹' },
    { id: 'work', complete: deliveryReady, label: '开始第一个任务' },
  ];
  return {
    availableCodeAgents,
    codeAgentReady,
    completed: deliveryReady,
    currentStep: deliveryReady ? steps.length : Math.max(0, steps.findIndex(step => !step.complete)),
    steps,
    runtimeReady,
    supervisorReady,
    selectedCodeAgent,
    targetEvidence,
    targetHandoff,
    targetWork,
  };
}

export function preselectedCodeAgentID(agents, project, selectedID = '') {
  const ready = agents.filter(agent => agent.enabled !== false && agent.submittable === true);
  return [selectedID, project?.provider, 'codex', ready[0]?.id].find(id => ready.some(agent => agent.id === id)) || '';
}

export const RUNTIME_REPAIR_COMMAND = './scripts/daemon.sh doctor\n./scripts/daemon.sh restart\nxuanwu doctor';

export function firstDeliveryRecovery(state) {
  if (!state.runtimeReady) return '运行环境检查未通过。可在运行玄武的机器上执行下方命令重启服务并检查；如果数据库仍异常，请按诊断结果修复后点击“重新检查”。';
  if (!state.codeAgentReady) return '还没有可用的编程工具。选择已就绪的工具，或完成本机工具安装与登录后重新发现。';
  if (!state.supervisorReady) return '玄武助手负责执行后的自动验收。请在这一步测试连接并保存，连接成功后继续。';
  if (!state.steps.find(step => step.id === 'project').complete) return '选择已有项目，或输入本地仓库绝对路径。路径检查通过后再添加；失败时会保留输入。';
  if (!state.targetWork) return '开始后会创建只读示例任务并进入详情页。请求超时后请先“重新检查”，避免重复创建。';
  if (state.targetWork.status === 'failed') return '示例任务没有通过验证，请进入任务详情查看原因，点“重试”让玄武再试一次，不要新建重复任务。';
  if (state.targetWork.status !== 'done') return '示例任务还在执行中。进入任务详情实时查看进度，也可以回到这里刷新交付状态。';
  if (state.targetEvidence.length === 0) return '示例任务已结束，但还没有通过的验证结果。请在任务详情中重试，让编程工具实际执行只读验证。';
  return '任务已有验证结果，还缺交付结果。点击“完成交付检查”即可在本页整理；如果检查未通过，点击“让玄武协助”继续处理。';
}

export function onboardingProjectID(cwd) {
  const normalized = String(cwd || '').trim().replace(/[\\/]+$/, '');
  const base = normalized.split(/[\\/]/).pop()?.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'project';
  return base.replace(/^-+|-+$/g, '') || 'project';
}

export function sampleWorkPayload(projectID, now = new Date().toISOString(), nonce = globalThis.crypto?.randomUUID?.() || `${Date.now()}`) {
  return {
    audit: {
      actor: { id: 'first-delivery-guide', kind: 'user' },
      correlation_id: `onboarding:first-delivery:${projectID}:${nonce}`,
      event_id: `onboarding:first-delivery:${projectID}:${nonce}`,
      occurred_at: now,
      reason: 'User requested the audited first-delivery sample Work',
    },
    goal: [
      '在 10 分钟内完成首次可审查交付。',
      "1. 首先直接执行 `printf 'Hello Xuanwu\\n'`，将 exact stdout `Hello Xuanwu` 作为第一条通过的验证结果。",
      '2. 随后只读检查项目 README、manifest 和当前 Git 状态；不修改文件。',
      '3. 再选择一条最小、只读的项目验证命令并直接执行，使结果成为后续验证结果。',
      '4. 汇报项目用途、可用的验证入口、一个风险和建议下一步。',
      '5. 通过现有确定性完成门禁结束任务；不 commit、push、deploy 或写入外部系统。',
    ].join('\n'),
    project_id: projectID,
    status: 'todo',
    title: FIRST_DELIVERY_TITLE,
    type: 'engineering_task',
  };
}
