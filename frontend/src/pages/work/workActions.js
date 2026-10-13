import { workApi } from '../../api/work.js';
import { WORK_BOARD_STATUSES, workDropOperation } from '../workBoardModel.js';
import { buildWorkActionPayload } from '../workDetailModel.js';

export function workStatusActions(status) {
  if (!WORK_BOARD_STATUSES.includes(status)) return [];
  const actions = new Map();
  for (const target of WORK_BOARD_STATUSES) {
    const operation = workDropOperation(status, target);
    if (operation === 'blocked' || operation === 'none') continue;
    const key = operation === 'update' ? `update:${target}` : operation;
    const current = actions.get(key);
    if (current) current.targets.push(target);
    else actions.set(key, { operation, target, targets: [target], label: operation === 'enqueue' ? '开始' : operation === 'retry' ? '重试' : operation === 'cancel' ? '取消' : target === 'todo' ? '加入队列' : '转待确认' });
  }
  return [...actions.values()];
}
export async function executeWorkMove(work, target) {
  const operation = workDropOperation(work.status, target);
  if (operation === 'none') return { operation, status: work.status };
  if (operation === 'blocked') throw new Error('此状态由执行或验收流程推进');
  const payload = buildWorkActionPayload(work, operation);
  const response = operation === 'update'
    ? await workApi.setQueueState(work.id, { ...payload, status: target })
    : await workApi.controlWork(work.id, operation, payload);
  return { operation, status: response?.work?.status || work.status };
}
export function workBlockReason(work, project) {
  const facts = work?.scheduling;
  const hold = facts?.project?.hold || project?.hold;
  if (hold) return `项目已暂停${hold.message ? `：${hold.message}` : ''}`;
  if (facts?.dependency?.ready === false) return facts.dependency.waiting_reason || '等待依赖或验证';
  if (facts?.tool?.submittable === false) return `编程工具未就绪${facts.tool.readiness_reason ? `：${facts.tool.readiness_reason}` : ''}`;
  if (work?.status === 'todo' && (facts?.project?.auto_run ?? project?.auto_run) === 0) return '项目未开启自动执行';
  return '';
}
