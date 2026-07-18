import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  automationCreatePayload, automationForm, automationUpdatePayload, filterAutomations,
  triggerChanged, triggerUpdatePayload
} from './automationsModel.js';

const DETAIL = {
  automation: {
    id: 'automation:weekday-review', mode: 'propose', name: 'Weekday review', next_run_at: '2026-07-20T01:00:00.000Z',
    owner: { kind: 'project', project_id: 'demo' }, permission_policy_ref: 'project-policy:demo', revision: 3,
    status: 'active', workflow_ref: 'workflow:investigate@1'
  },
  trigger: { type: 'cron', config: { expression: '0 9 * * 1-5', timezone: 'Asia/Shanghai' } }
};

test('builds native create/update/trigger payloads without legacy cron or pi fields', () => {
  const form = automationForm(DETAIL);
  assert.deepEqual(automationCreatePayload(form).trigger, DETAIL.trigger);
  assert.equal(automationCreatePayload({ ...form, id: '' }).id, 'weekday-review');
  assert.deepEqual(automationUpdatePayload({ ...form, name: 'Edited' }, 3), {
    expected_revision: 3, mode: 'propose', name: 'Edited', next_run_at: '2026-07-20T01:00:00.000Z',
    permission_policy_ref: 'project-policy:demo', workflow_ref: 'workflow:investigate@1'
  });
  assert.equal(triggerChanged(form, DETAIL), false);
  assert.deepEqual(triggerUpdatePayload({ ...form, trigger_type: 'continuous', trigger_interval: '60' }, 4), {
    expected_revision: 4, next_run_at: '2026-07-20T01:00:00.000Z',
    trigger: { type: 'continuous', config: { poll_interval_seconds: 60 } }
  });
});

test('filters list by user-visible identity', () => {
  const items = [DETAIL.automation, { id: 'automation:release', name: 'Release', owner: { project_id: 'web' }, workflow_ref: 'workflow:release@1' }];
  assert.deepEqual(filterAutomations(items, 'demo').map(item => item.id), ['automation:weekday-review']);
  assert.deepEqual(filterAutomations(items, 'release').map(item => item.id), ['automation:release']);
});

test('top-level Automations page exposes editor, history, run-now, filters, realtime refresh, and states', () => {
  const page = readFileSync(new URL('./Automations.jsx', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');
  for (const token of ['AutomationEditor', 'History', 'runNow', 'AutomationFilters', 'subscribeToEvents', 'AutomationState']) assert.match(page, new RegExp(token));
  assert.match(app, /currentPage === 'automations'[\s\S]*<Automations/);
  assert.doesNotMatch(app, /currentPage === 'automations'[\s\S]{0,80}<Cron/);
});
