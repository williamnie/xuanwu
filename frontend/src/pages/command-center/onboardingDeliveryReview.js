import { buildGlobalComposerSubmission } from '../../components/globalAskComposerModel.js';

export async function openDeliveryReview(work, api, onReady) {
  const projectID = work?.owner?.project_id;
  if (!/^xw:work:issues:[1-9]\d*$/.test(work?.id || '') || !projectID) {
    throw new Error('任务或所属项目尚未加载，请先刷新交付状态');
  }
  const title = `首次交付检查 · ${work.id}`;
  const response = await api.getPiConversations({ projectId: projectID });
  const conversations = Array.isArray(response) ? response : response?.items || [];
  const existing = conversations.find(item => item.title === title && item.project_id === projectID);
  if (existing) {
    onReady(existing.id);
    return;
  }
  const submission = buildGlobalComposerSubmission({
    references: [{ type: 'work', id: work.id, metadata: { project_id: projectID } }],
    prompt: `请完成 ${work.id} 的首次交付检查。先读取该 Work、Run、Evidence 和 Handoff 的真实状态。`
      + '仅针对这个已有 Work，通过现有执行和证据接口补齐缺失的只读验证，不得用文字结论代替实际证据；'
      + '已有有效交付时只汇报结果。不要新建或重跑其他 Work，不修改项目文件，不 commit、push、部署或发布。'
      + '保留现有 Action Gate；需要用户判断或批准时在本会话说明具体原因并等待回复。'
      + '验证齐全后提示用户点击本页“完成交付检查”，由确定性入口生成凭证，不手写 Handoff。最后说明执行结果、验证结果、还缺什么及用户下一步。',
  });
  const conversation = await api.createPiConversation({ ...submission.conversation, title });
  onReady(conversation.id);
  // 会话先持久化；流中断后回到同一会话，不自动重放可能已执行的检查。
  await api.sendPiConversationMessage(conversation.id, submission.message);
}
