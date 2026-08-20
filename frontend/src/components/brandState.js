export const BRAND_STATES = Object.freeze({
  idle: 'idle',
  monitor: 'monitor',
  running: 'running',
  speed: 'speed',
  guarding: 'guarding',
  sleeping: 'sleeping',
  offline: 'offline',
});

const NIGHT_START_HOUR = 22;
const NIGHT_END_HOUR = 8;
const ACTIVE_ISSUE_STATUS = 'in_progress';
const ACTIVE_LOOP_STATUS = 'running';
const ACTIVE_AUTOMATION_STATUS = 'active';
const GUARDING_PATTERN = /verifier|verify|guardian|guard|supervisor|quality|gate|验证|守护|门禁/i;

export function normalizeBrandState(state) {
  return Object.values(BRAND_STATES).includes(state) ? state : BRAND_STATES.idle;
}

export function resolveRunnerBrandState({
  backendOnline = true,
  issues = [],
  workSummary,
  projects = [],
  automations = [],
  now = new Date(),
} = {}) {
  if (!backendOnline) return BRAND_STATES.offline;

  const activeIssues = safeItems(issues).filter(isActiveIssue);
  const activeCount = workSummary?.counts
    ? Number(workSummary.counts.in_progress) || 0
    : activeIssues.length;
  const guarding = workSummary?.activity
    ? Number(workSummary.activity.guarding) > 0
    : activeIssues.some(isGuardingIssue);
  if (guarding) return BRAND_STATES.guarding;
  if (activeCount > 1) return BRAND_STATES.speed;
  if (activeCount > 0) return BRAND_STATES.running;

  if (isNightTime(now)) return BRAND_STATES.sleeping;
  if (safeItems(projects).some(isMonitoringProject)) return BRAND_STATES.monitor;
  if (safeItems(automations).some(isActiveAutomation)) return BRAND_STATES.monitor;
  return BRAND_STATES.idle;
}

export function isNightTime(now = new Date()) {
  const hour = typeof now?.getHours === 'function' ? now.getHours() : new Date(now).getHours();
  return hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR;
}

function safeItems(value) {
  return Array.isArray(value) ? value : [];
}

function isActiveIssue(issue) {
  return issue?.status === ACTIVE_ISSUE_STATUS;
}

function isGuardingIssue(issue) {
  const text = `${issue?.title || ''} ${issue?.kind || ''} ${issue?.type || ''}`;
  return GUARDING_PATTERN.test(text);
}

function isMonitoringProject(project) {
  return project?.loop_status === ACTIVE_LOOP_STATUS || Number(project?.auto_run) === 1;
}

function isActiveAutomation(automation) {
  return automation?.status === ACTIVE_AUTOMATION_STATUS;
}
