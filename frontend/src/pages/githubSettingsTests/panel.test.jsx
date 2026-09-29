import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { GitHubSettingsView } from '../GitHubSettingsPanel.jsx';
import { initialGitHubSettings, newGitHubRepository } from '../githubSettingsModel.js';

const settings = { enabled: true, auth: { mode: 'connector', appId: '', installationId: '', privateKeyRef: '' }, pollIntervalSeconds: 60, repositories: [newGitHubRepository('fixture')] };
function state() {
  return { ...initialGitHubSettings(), draft: settings, revision: 'one', remote: { revision: 'one', settings,
    application: { status: 'pending', active_settings: { ...settings, enabled: false } }, runtime: { enabled: false, last_run_at: '' },
    permissions: { note: '不授予自动合并和部署权限' }, credential: { reference: 'env://FIXTURE_TOKEN' }, projects: [{ id: 'fixture', name: 'Fixture' }],
    repositories: [{ repository: 'owner/repo', project_id: 'fixture', intake_label: 'xuanwu', cases: ['investigate', 'repair', 'needs_user', 'review'].map((phase, index) => ({ issue_number: index + 1, phase, stage: phase === 'needs_user' ? 'repair' : phase, intake_status: index === 0 ? 'label_mismatch' : 'matched', external_state: 'open', source_revision: 1, issue_id: 20 + index, work_status: phase === 'needs_user' ? 'needs_user' : 'done', pull_request_number: index === 3 ? 7 : null })) }] } };
}
function render(value) { return renderToStaticMarkup(<GitHubSettingsView state={value} dispatch={() => {}} onRefresh={() => {}} onAction={() => {}} />); }
test('settings component renders saved/pending, references and all Case phases with separate Work and PR facts', () => {
  const html = render(state());
  for (const text of ['已保存 · 未生效', '调查', '修复', '求助 · 等待回答', 'PR · 等待评审', '标签不匹配', 'Work #23 · done', 'PR #7', 'env://FIXTURE_TOKEN', '不授予自动合并和部署权限', '查看当前生效规则']) expect(html).toContain(text);
  expect(html).not.toContain('type="password"');
  expect(html).not.toContain('allowMerge');
});
test('component displays actionable failures and prevents applying dirty drafts or editing during an operation', () => {
  const value = state();
  value.error = 'config_conflict：刷新核对'; value.conflict = true;
  expect(render(value)).toContain('role="alert"');
  expect(render(value)).toContain('使用保存版本');
  value.busy = true;
  expect(render(value)).toMatch(/<fieldset[^>]*disabled=""/);
  value.busy = false; value.conflict = false;
  value.draft = { ...settings, enabled: false };
  expect(render(value)).toMatch(/<button[^>]*disabled=""[^>]*>应用配置/);
});
test('connection failures stay visible and write authorization remains unverified', () => {
  const value = state();
  value.testResult = { repositories: [{ repository: 'owner/repo', status: 'permission_denied' }] };
  expect(render(value)).toContain('权限不足');
  expect(render(value)).toContain('写权限尚未验证');
});
