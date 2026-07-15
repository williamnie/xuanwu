import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./piChatState.js', import.meta.url), 'utf8');
const panelSource = readFileSync(new URL('./PiChat.jsx', import.meta.url), 'utf8');

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
  assert.match(source, /promptWithProjectContext\(text, targetProject \|\| state\.selectedProject\)/);
  assert.match(source, /project_id:\s*currentProjectId\(state, options\.project\)/);
});


test('Supervisor chat uses a failure fallback instead of empty-text wording', () => {
  assert.match(source, /runnerReplyText\(result\)/);
  assert.match(source, /result\?\.status === 'failed'/);
  assert.match(source, /Supervisor 执行失败，未返回错误详情/);
});

test('PI Assistant chat switches conversations by loading persisted transcript detail', () => {
  assert.match(source, /assistantApi\.getPiConversation\(id\)/);
  assert.match(source, /setTranscript\(conversationTranscript\(detail\)\)/);
  assert.match(source, /function conversationTranscript\(detail\)/);
});

test('PI Assistant chat tracks selected conversation and updates title from message result', () => {
  assert.match(source, /const selectedConversation = useMemo/);
  assert.match(source, /selectedConversation,\s*selectedConversationId/);
  assert.match(source, /createConversation\('New conversation'/);
  assert.match(source, /applyConversationTitle\(state, conversationId, result\?\.title\)/);
  assert.doesNotMatch(source, /new Date\(\)\.toLocaleString/);
});

test('PI Assistant chat uses the default PI agent without exposing an agent selector', () => {
  assert.doesNotMatch(panelSource, /function AgentSelect/);
  assert.doesNotMatch(panelSource, /<select className="form-control" value=\{selected\}/);
  assert.doesNotMatch(panelSource, /Runner Agent/);
  assert.doesNotMatch(source, /pi_agent_id:\s*state\.selectedAgentId/);
  assert.match(source, /assistantApi\.createPiConversation\(\{\s*project_id:/);
  assert.doesNotMatch(source, /ensureConversationInput/);
});

test('PI Assistant chat can infer project from natural @project mention text', async () => {
  const module = await import('./piChatProjectContext.js');
  const projects = [
    { id: 'codex-issue-runner', name: 'codex-issue-runner' },
    { id: 'movo-web', name: 'movo-web' },
  ];
  assert.equal(module.projectFromPrompt('@codex-issue-runner 创建 issue', projects)?.id, 'codex-issue-runner');
  assert.equal(module.projectFromPrompt('@project:movo-web 做 smoke', projects)?.id, 'movo-web');
  assert.match(module.promptWithProjectContext('创建 issue', projects[0]), /目标项目：@project:codex-issue-runner/);
});
