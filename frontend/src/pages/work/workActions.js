import { workApi } from '../../api/work.js';
import { issueIdFromWorkId, workDropOperation } from '../workBoardModel.js';

// 列表行的显式操作与看板拖拽是同一张表：每个动作都落到 workDropOperation 允许的目标状态，
// 走同一组受门禁保护的 Issue 接口；不新增任何看板做不到的状态迁移。
const ROW_ACTIONS = {
  triage: [
    { id: 'enqueue', label: '加入执行队列', target: 'in_progress', primary: true },
    { id: 'cancel', label: '取消任务', target: 'cancelled', confirm: true, danger: true },
  ],
  todo: [
    { id: 'enqueue', label: '开始执行', target: 'in_progress', primary: true },
    { id: 'back-to-triage', label: '移回待确认', target: 'triage' },
    { id: 'cancel', label: '取消任务', target: 'cancelled', confirm: true, danger: true },
  ],
  in_progress: [
    { id: 'retry', label: '中断并重新排队', target: 'todo', confirm: true },
    { id: 'cancel', label: '取消任务', target: 'cancelled', confirm: true, danger: true },
  ],
  needs_user: [
    { id: 'cancel', label: '取消任务', target: 'cancelled', confirm: true, danger: true },
  ],
  failed: [
    { id: 'retry', label: '重试', target: 'in_progress', primary: true },
    { id: 'back-to-triage', label: '移回待确认', target: 'triage' },
    { id: 'cancel', label: '取消任务', target: 'cancelled', confirm: true, danger: true },
  ],
};

export function workRowActions(status) {
  return (ROW_ACTIONS[status] || []).filter(action => {
    const operation = workDropOperation(status, action.target);
    return operation !== 'blocked' && operation !== 'none';
  });
}

export async function executeWorkMove(work, targetStatus) {
  const issueId = issueIdFromWorkId(work?.id);
  if (!issueId) throw new Error('这个任务没有可写入的 Issue');
  const operation = workDropOperation(work.status, targetStatus);
  if (operation === 'none') return { operation, status: work.status };
  if (operation === 'blocked') throw new Error('该状态由执行或验收流程推进，不能手动切换');
  let result;
  if (operation === 'enqueue') result = await workApi.enqueueIssue(issueId);
  else if (operation === 'retry') result = await workApi.retryIssue(issueId);
  else if (operation === 'cancel') result = await workApi.cancelIssue(issueId);
  else result = await workApi.updateIssue(issueId, { status: targetStatus });
  return { operation, status: result?.status || targetStatus };
}
