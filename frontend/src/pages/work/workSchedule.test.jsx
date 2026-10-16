import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nContext } from '../../i18n/context.js';
import { translate } from '../../i18n/translations.js';
import WorkSchedule, { ScheduleBlockerLinks } from './WorkSchedule.jsx';
import { scheduleBlockers, scheduleReasonText, scheduleWorkHref, workScheduleSummary } from './workScheduleModel.js';

const dependency = { code: 'dependency_failed', detail: { root_blockers: [
  { work_id: 'xw:work:issues:42', title: '上线校验', status: 'failed' },
  { work_id: 'xw:work:issues:42', title: '重复', status: 'failed' },
  { work_id: 'javascript:alert(1)', title: 'invalid', status: 'failed' },
  { work_id: 'xw:work:issues:99', title: 'missing', status: 'missing' },
] } };
const work = { status: 'todo', schedule: { state: 'waiting', reasons: [dependency, { code: 'capacity_full' }] } };
const t = key => translate('zh-CN', key);

test('every queue reason has paired human copy, runnable does not promise an immediate start', () => {
  const codes = ['project_hold', 'auto_run_off', 'dependency_waiting', 'dependency_failed', 'dependency_missing',
    'dependency_cycle', 'readiness_waiting', 'workspace_waiting', 'provider_unavailable', 'project_busy', 'capacity_full'];
  for (const language of ['zh-CN', 'en-US']) for (const code of codes) {
    // 直接核对文案键存在；scheduleReasonText 对缺失键会退回 unknown，不能用来证明配对。
    assert.notEqual(translate(language, `schedule.${code}`), `schedule.${code}`);
  }
  assert.equal(scheduleReasonText({ code: 'future_gate' }, t), t('schedule.unknown'));
  assert.match(scheduleReasonText({ code: 'project_busy', detail: { holder: 'awaiting_user' } }, t), /等你处理/);
  assert.equal(scheduleReasonText({ code: 'project_busy', detail: { holder: 'running' } }, t), t('schedule.project_busy'));
  assert.equal(workScheduleSummary(work, t), '依赖任务失败');
  assert.match(workScheduleSummary({ status: 'todo', schedule: { state: 'runnable', reasons: [] } }, t), /等待调度/);
  assert.equal(workScheduleSummary({ ...work, status: 'failed' }, t), '');
  assert.equal(workScheduleSummary({ status: 'todo' }, t), '');
});

test('compact views show the first reason; detail shows every reason with safe task deep links', () => {
  const compact = renderToStaticMarkup(<WorkSchedule work={work} />);
  assert.match(compact, /依赖任务失败/);assert.doesNotMatch(compact, /并发已满/);
  const detail = renderToStaticMarkup(<WorkSchedule all work={work} />);
  assert.match(detail, /依赖任务失败/);assert.match(detail, /并发已满/);assert.match(detail, /SCHEDULE/);
  assert.equal(scheduleBlockers(dependency).length, 1);
  const href = scheduleWorkHref('xw:work:issues:42');
  assert.ok(detail.includes(href));
  assert.equal(new URLSearchParams(href.split('?')[1]).get('workId'), 'xw:work:issues:42');
  assert.ok(href.startsWith('#/tasks?'));
  assert.doesNotMatch(detail, /javascript|missing|重复/);
  assert.equal(renderToStaticMarkup(<ScheduleBlockerLinks reason={{ code: 'project_hold' }} />), '');
});

test('nonqueued views do not inherit a stale schedule and English renders through the shared component', () => {
  assert.equal(renderToStaticMarkup(<WorkSchedule work={{ ...work, status: 'done' }} />), '');
  const markup = renderToStaticMarkup(<I18nContext.Provider value={{ t: key => translate('en-US', key) }}><WorkSchedule all work={work} /></I18nContext.Provider>);
  assert.match(markup, /A dependency failed/);assert.match(markup, /Execution capacity is full/);
});

test('all four surfaces consume the projection and old readiness is not duplicated on the home card', () => {
  const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
  assert.match(read('./TaskList.jsx'), /workScheduleSummary\(work, t\)/);
  assert.match(read('../WorkBoard.jsx'), /<WorkSchedule work={work}/);
  assert.match(read('../WorkDetail.jsx'), /work.schedule \? <WorkSchedule all work={work}/);
  assert.match(read('../command-center/ActiveWorkSection.jsx'), /!item.schedule && item.readiness/);
  assert.match(read('../command-center/ActiveWorkSection.jsx'), /<WorkSchedule work={item}/);
});
