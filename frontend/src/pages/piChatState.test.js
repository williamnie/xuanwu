import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./piChatState.js', import.meta.url), 'utf8');
const panelSource = readFileSync(new URL('./PiChat.jsx', import.meta.url), 'utf8');
const runtimeSource = readFileSync(new URL('./piChatRuntimeState.js', import.meta.url), 'utf8');

test('PI Assistant chat loader keeps a stable callback and loads projects for @ mentions', () => {
  assert.match(source, /function usePiChatLoader\(setters\)/);
  assert.doesNotMatch(source, /useCallback\([\s\S]*\], \[[^\]]*state[^\]]*\]\)/);
  assert.doesNotMatch(source, /selectedProjectId/);
  assert.doesNotMatch(source, /setSelectedProjectId/);
  assert.match(source, /projectsApi\.getProjects\(\)/);
  assert.match(source, /setProjects\(projectList \|\| \[\]\)/);
});

test('PI Assistant chat sends PI prompt with project context instead of session runtime overrides', () => {
  assert.doesNotMatch(source, /defaultMessageSettings/);
  assert.doesNotMatch(source, /runnerMessageSettings/);
  assert.doesNotMatch(source, /approval_policy:\s*settings\.approvalPolicy/);
  assert.match(source, /piChatMessageWithProjectContext\(text, targetProject \|\| state\.selectedProject\)/);
  assert.match(source, /state\.setPrompt\(''\);\s*state\.setReferences\(\[\]\);/);
  assert.match(source, /project_id:\s*currentProjectId\(state, options\.project\)/);
});

test('mentioning a project reuses the selected conversation instead of replacing its session', () => {
  assert.match(source, /const conversationId = state\.selectedConversationId\s*\|\| await createConversation\('New conversation', \{ project: targetProject \}\)/);
  assert.doesNotMatch(source, /shouldCreateProjectConversation/);
});


test('Xuanwu Chat uses a failure fallback instead of empty-text wording', () => {
  assert.match(source, /runnerReplyText\(result\)/);
  assert.match(source, /result\?\.status === 'failed'/);
  assert.match(source, /Xuanwu 执行失败，未返回错误详情/);
  assert.match(source, /Xuanwu 未返回内容/);
});

test('PI Assistant chat switches conversations by loading persisted transcript detail', () => {
  assert.match(source, /assistantApi\.getPiConversation\(id\)/);
  assert.match(source, /applyConversationDetail\(\{/);
  assert.match(runtimeSource, /replacePiTurnText\(transcript, detail\.active_turn_id, detail\.active_text, id\)/);
  assert.match(runtimeSource, /function conversationTranscript\(detail\)/);
});

test('PI Assistant chat tracks selected conversation and updates title from message result', () => {
  assert.match(source, /const selectedConversation = useMemo/);
  assert.match(source, /selectedConversation,\s*selectedConversationId/);
  assert.match(source, /createConversation\('New conversation'/);
  assert.match(source, /applyConversationTitle\(state, conversationId, result\?\.title\)/);
  assert.doesNotMatch(source, /new Date\(\)\.toLocaleString/);
});

test('PI Assistant chat owns the current POST SSE Turn and reconnects through global runtime events', () => {
  assert.match(source, /createPiChatTurnManager\(\)/);
  assert.match(source, /signal:\s*turn\.controller\.signal/);
  assert.match(source, /onEvent:\s*\(streamEvent\) => applyPiTurnEvent/);
  assert.match(source, /turnManager\.cancel\('conversation_switch'\)/);
  assert.match(source, /eventsApi\.subscribeToEvents/);
  assert.match(source, /RUNTIME_REFRESH_INTERVAL_MS/);
  assert.match(source, /document\.addEventListener\('visibilitychange'/);
  assert.match(source, /runtime_status === 'running'/);
  assert.doesNotMatch(source, /usePiConversationEvents|setPiLiveConversation|clearPiLiveAssistant/);
});

test('PI Assistant chat uses the default PI agent without exposing an agent selector', () => {
  assert.doesNotMatch(panelSource, /function AgentSelect/);
  assert.doesNotMatch(panelSource, /<select className="form-control" value=\{selected\}/);
  assert.doesNotMatch(panelSource, /Runner Agent/);
  assert.doesNotMatch(source, /pi_agent_id:\s*state\.selectedAgentId/);
  assert.match(source, /assistantApi\.getPiSupervisor\(\)/);
  assert.doesNotMatch(source, /getPiAgents|selectedAgentId|setSelectedAgentId/);
  assert.match(source, /assistantApi\.createPiConversation\(\{\s*project_id:/);
  assert.doesNotMatch(source, /ensureConversationInput/);
});

test('PI Assistant chat can infer project from natural @project mention text', async () => {
  const module = await import('./piChatProjectContext.js');
  const projects = [
    { id: 'xuanwu', name: 'xuanwu' },
    { id: 'movo-web', name: 'movo-web' },
  ];
  assert.equal(module.projectFromPrompt('@xuanwu 创建 issue', projects)?.id, 'xuanwu');
  assert.equal(module.projectFromPrompt('@project:movo-web 做 smoke', projects)?.id, 'movo-web');
  assert.match(module.promptWithProjectContext('创建 issue', projects[0]), /目标项目：@project:xuanwu/);
  assert.deepEqual(module.piChatMessageWithProjectContext('创建 issue', projects[0]), {
    prompt: '目标项目：@project:xuanwu xuanwu\n项目路径：未记录\n\n创建 issue',
    target_project_id: 'xuanwu',
    target_project_source: 'request_project',
  });
});
