import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterTimelineItems,
  timelineChips,
  timelineItemDisplay,
  timelineStageLabel,
  viewFilterLabel,
} from './piHeartbeatTimelineDisplay.js';

test('heartbeat timeline maps raw audit events to Chinese user-readable display', () => {
  const display = timelineItemDisplay({
    error: '',
    event_type: 'execution_result',
    message: 'PI recorded the result.',
    payload_json: '{"action_type":"issue.create"}',
    result_json: '{"action_type":"issue.create","status":"completed"}',
    source: 'action',
    stage: 'result',
  });

  assert.equal(display.stageLabel, '执行结果');
  assert.equal(display.title, 'issue 创建完成');
  assert.equal(display.description, 'PI 已记录执行结果。');
  assert.doesNotMatch(`${display.title}${display.description}`, /audit|recorded|execution/i);
});

test('heartbeat timeline labels decisions, supervisor failures, and filters in Chinese', () => {
  const gate = timelineItemDisplay({
    decision: 'execute',
    error: '',
    event_type: 'gate_decision',
    message: 'low-risk action is allowed by gate',
    payload_json: '{"action_type":"issue.enqueue"}',
    result_json: '{}',
    source: 'action',
    stage: 'decision',
  });
  const supervisor = timelineItemDisplay({
    error: '',
    event_type: 'supervisor_decision_failed',
    message: 'PI supervisor agent is not runnable',
    payload_json: '{}',
    result_json: '{}',
    source: 'supervisor',
    stage: 'supervisor_decision',
  });

  assert.equal(timelineStageLabel('signal'), '发现信号');
  assert.equal(gate.title, '授权通过');
  assert.equal(gate.description, '低风险动作已通过准入检查，可继续执行。');
  assert.equal(supervisor.title, '恢复判断失败');
  assert.equal(supervisor.description, '自动恢复代理当前不可执行，已记录为待处理。');
  assert.equal(viewFilterLabel('attention'), '待确认');
});

test('heartbeat timeline keeps hashes in secondary chips and supports focused filters', () => {
  const items = [
    { error: '', event_type: 'execution_result', message: '', stage: 'result' },
    { error: '', event_type: 'pending_approval', message: '', stage: 'decision' },
    { error: 'boom', event_type: 'execution_error', message: '', stage: 'result' },
  ];
  const chips = timelineChips({
    action_id: 'action:c7d4c5aabb',
    decision: 'execute',
    heartbeat_id: 'heartbeat-abcdef',
    issue_id: 312,
    payload_json: '{"action_type":"needs_user.escalate"}',
    project_id: 'codex-issue-runner',
    result_json: '{}',
    source: 'action',
  }, (value) => value.slice(0, 6));

  assert.deepEqual(filterTimelineItems(items, 'result'), [items[0], items[2]]);
  assert.deepEqual(filterTimelineItems(items, 'attention'), [items[1]]);
  assert.deepEqual(filterTimelineItems(items, 'abnormal'), [items[2]]);
  assert.deepEqual(chips.map((chip) => chip.text), [
    '项目：codex-issue-runner',
    'Issue：#312',
    '动作类型：提醒人工确认（needs_user.escalate）',
    '决策：允许执行',
    '来源：动作记录',
    '检查：heartb',
    '动作：action',
  ]);
  assert.equal(chips.at(-1).muted, true);
});
