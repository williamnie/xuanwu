export const FIRST_DELIVERY_TITLE = '玄武首次交付：只读项目体检';

export function firstDeliveryState({ connectionTest = null, doctor, evidence = [], handoffs = [], projects = [], works = [] } = {}) {
  const runtimeReady = Boolean(doctor?.service?.alive && doctor?.db?.ok);
  const availableProviders = (doctor?.providers || []).filter(provider => provider?.available);
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
  const targetWork = deliveredHandoff ? workByID.get(deliveredHandoff.work_id) : sampleWork || works[0] || null;
  const targetEvidence = targetWork
    ? evidence.filter(item => item?.work_id === targetWork.id && item?.status === 'passed')
    : [];
  const targetHandoff = targetWork
    ? handoffs.find(item => item?.work_id === targetWork.id && item?.evidence_count > 0) || null
    : null;
  const deliveryReady = Boolean(
    targetWork?.status === 'done'
    && targetEvidence.length > 0
    && targetHandoff,
  );
  const agentReady = availableProviders.length > 0 && connectionTest?.ok === true;

  return {
    availableProviders,
    completed: deliveryReady,
    currentStep: deliveryReady ? 5
      : !runtimeReady ? 0
        : !agentReady ? 1
          : projects.length === 0 ? 2
            : !targetWork ? 3
              : 4,
    steps: [
      { id: 'runtime', complete: runtimeReady, label: '运行环境可用' },
      { id: 'agent', complete: agentReady, label: 'Agent 连接测试通过' },
      { id: 'project', complete: projects.length > 0, label: '已添加项目' },
      { id: 'work', complete: Boolean(targetWork), label: '已创建首个 Work' },
      { id: 'delivery', complete: deliveryReady, label: 'Work 已完成且有 Evidence / Handoff' },
    ],
    targetEvidence,
    targetHandoff,
    targetWork,
  };
}

export function firstDeliveryRecovery(state, doctor) {
  if (!state.steps[0].complete) {
    return '运行环境未就绪。先执行 `codex-issue-runner doctor` 和 `./scripts/daemon.sh doctor`；修复 API/DB 后回到 Command Center 点击“重新检查”。';
  }
  if (!state.steps[1].complete) {
    const available = state.availableProviders.length > 0;
    const providers = (doctor?.providers || []).map(provider => provider?.label || provider?.id).filter(Boolean).join(' / ') || 'Codex';
    return available
      ? '执行器 CLI 已可用，但当前浏览器会话还没有成功的 provider 连接测试。在普通 Settings → Models & Agents 测试并保存；无需进入 Advanced。'
      : `未找到可用执行器（${providers}）。先确认 CLI 已安装并登录，再在普通 Settings → Models & Agents 执行连接测试。`;
  }
  if (!state.steps[2].complete) {
    return '还没有项目。输入一个已存在的本地仓库绝对路径；创建失败时保留原路径，修正后可直接重试。';
  }
  if (!state.steps[3].complete) {
    return '创建只读示例 Work。操作会先检查 Issue-backed Work authority；请求超时后必须先“重新检查”，确认未落库后才可再创建。';
  }
  const workID = state.targetWork?.id || '<work-id>';
  if (state.targetWork?.status === 'failed') {
    return `Work ${workID} 执行失败。在 Runs 查看错误，修复 Agent/权限后使用既有 Retry；不要新建重复 Work。`;
  }
  if (state.targetWork?.status !== 'done') {
    return `Work ${workID} 尚未完成。在 Runs 查看当前 Run；若未启动，到 Projects 启动该项目 Loop。`;
  }
  if (state.targetEvidence.length === 0) {
    return `Work ${workID} 已结束但没有 passed Evidence。重试时要求 Agent 直接执行一条最小只读验证命令，不得用文本结论代替 Evidence。`;
  }
  return `Work ${workID} 已有 Evidence 但尚无同 Work Handoff。不要手写或复制 Handoff；先打开该 Work，再使用已附带 Work 上下文的 Ask Xuanwu 运行已注册 Workflow，并在确定性 Action Gate 中确认。`;
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
      '1. 只读检查项目 README、manifest 和当前 Git 状态；不修改文件。',
      '2. 选择一条最小、只读的验证命令并直接执行，使结果成为 Evidence。',
      '3. 汇报项目用途、可用的验证入口、一个风险和建议下一步。',
      '4. 通过现有确定性完成门禁结束 Work；不 commit、push、deploy 或写入外部系统。',
    ].join('\n'),
    project_id: projectID,
    status: 'todo',
    title: FIRST_DELIVERY_TITLE,
    type: 'engineering_task',
  };
}
