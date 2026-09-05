export const FIRST_DELIVERY_TITLE = '玄武首次交付：只读项目体检';

export function firstDeliveryState({ codeAgents = [], connectionTest = null, doctor, evidence = [], handoffs = [], projects = [], selectedCodeAgentID = '', targetWorkID = '', works = [] } = {}) {
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

  return {
    availableCodeAgents,
    codeAgentReady,
    completed: deliveryReady,
    currentStep: deliveryReady ? 6
      : !runtimeReady ? 0
        : !codeAgentReady ? 1
          : !supervisorReady ? 2
            : projects.length === 0 ? 3
              : !targetWork ? 4
                : 5,
    steps: [
      { id: 'runtime', complete: runtimeReady, label: '玄武可以运行' },
      { id: 'code-agent', complete: codeAgentReady, label: '选择谁来做' },
      { id: 'supervisor', complete: supervisorReady, label: '配置玄武' },
      { id: 'project', complete: projects.length > 0, label: '告诉玄武项目在哪' },
      { id: 'work', complete: Boolean(targetWork), label: '启动第一个 Issue' },
      { id: 'delivery', complete: deliveryReady, label: '看到执行结果' },
    ],
    supervisorReady,
    selectedCodeAgent,
    targetEvidence,
    targetHandoff,
    targetWork,
  };
}

export function firstDeliveryRecovery(state, doctor) {
  if (!state.steps[0].complete) {
    return '运行环境未就绪。先执行 `xuanwu doctor` 和 `./scripts/daemon.sh doctor`；修复 API/DB 后回到 Dashboard 点击“重新检查”。';
  }
  if (!state.steps[1].complete) {
    const discovered = (doctor?.providers || []).map(provider => provider?.label || provider?.id).filter(Boolean).join(' / ') || 'Codex';
    return `尚未选择已启用且就绪的 Code Agent（已发现：${discovered}）。在当前步骤选择 Codex CLI / Codex App 或其他可用执行器。`;
  }
  if (!state.steps[2].complete) {
    return 'Code Agent 已选定，但当前浏览器会话还没有成功的 Supervisor 连接测试。在当前步骤完成 API 或 Codex OAuth 连接并保存；无需进入 Advanced。';
  }
  if (!state.steps[3].complete) {
    return '还没有项目。输入一个已存在的本地仓库绝对路径；创建失败时保留原路径，修正后可直接重试。';
  }
  if (!state.steps[4].complete) {
    return '创建只读示例 Work。操作会先检查 Issue-backed Work authority；请求超时后必须先“重新检查”，确认未落库后才可再创建。';
  }
  const workID = state.targetWork?.id || '<work-id>';
  if (state.targetWork?.status === 'failed') {
    return `Work ${workID} 执行失败。如需查看 Runs 详情，点击右上角“稍后设置”进入指挥中心；修复 Agent/权限后使用既有 Retry，不要新建重复 Work。`;
  }
  if (state.targetWork?.status !== 'done') {
    return `Work ${workID} 尚未完成。先点击“刷新交付状态”；若仍无进展，可稍后进入指挥中心，从 Runs 查看当前 Run。`;
  }
  if (state.targetEvidence.length === 0) {
    return `Work ${workID} 已结束但没有 passed Evidence。重试时要求 Agent 直接执行一条最小只读验证命令，不得用文本结论代替 Evidence。`;
  }
  return `任务 ${workID} 已有验证结果，还缺交付凭证。点击“完成交付检查”即可在本页整理；如果检查未通过，点击“让玄武协助”继续处理。`;
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
      "1. 首先直接执行 `printf 'Hello Xuanwu\\n'`，将 exact stdout `Hello Xuanwu` 作为第一条 passed Evidence。",
      '2. 随后只读检查项目 README、manifest 和当前 Git 状态；不修改文件。',
      '3. 再选择一条最小、只读的项目验证命令并直接执行，使结果成为后续 Evidence。',
      '4. 汇报项目用途、可用的验证入口、一个风险和建议下一步。',
      '5. 通过现有确定性完成门禁结束 Work；不 commit、push、deploy 或写入外部系统。',
    ].join('\n'),
    project_id: projectID,
    status: 'todo',
    title: FIRST_DELIVERY_TITLE,
    type: 'engineering_task',
  };
}
