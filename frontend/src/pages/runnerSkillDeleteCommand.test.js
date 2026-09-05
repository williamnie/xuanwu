import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const skillSource = readFileSync(new URL('../../../skills/xuanwu/SKILL.md', import.meta.url), 'utf8');

test('xuanwu skill documents protected issue delete command', () => {
  assert.match(skillSource, /issue delete --addr/);
  assert.match(skillSource, /physically removes the issue/);
  assert.match(skillSource, /in_progress/);
});

test('xuanwu skill keeps plain-language unattended decomposition rules', () => {
  const planningSource = readFileSync(new URL('../../../skills/xuanwu/references/issue-planning.md', import.meta.url), 'utf8');
  const instructions = skillSource + planningSource;
  assert.match(instructions, /references\/issue-planning\.md/);
  assert.match(instructions, /must \*\*说人话\*\*/);
  assert.match(instructions, /match the language of the user's current request/);
  assert.match(instructions, /write Issue titles, `一句话目标`.*in Simplified Chinese/);
  assert.match(instructions, /Every Issue must have one `一句话目标`/);
  assert.match(instructions, /Do not target a fixed Issue count/);
  assert.match(instructions, /Determine the count dynamically/);
  assert.match(instructions, /Ask at most one question for the entire batch/);
  assert.match(instructions, /Only enqueue `夜间可执行` Issues/);
  assert.match(instructions, /Create `需要人工` Issues as `triage` and do not enqueue them/);
  assert.match(instructions, /selected Agent Profile resolves to `approval=unattended`/);
  assert.match(instructions, /report `needs_user` truthfully/);
  assert.match(instructions, /Never label it `failed` or `done` merely to release the workspace lock/);
  assert.match(instructions, /essential context exists only in the planning conversation/);
  assert.match(instructions, /exact `Issue #<id>` references/);
  assert.match(instructions, /issue update --depends-on/);
  assert.match(instructions, /xuanwu issue enqueue/);
  assert.match(instructions, /待人工验收 N 项，完成前不算整体验收通过/);
  assert.match(instructions, /Do not make the user read every Issue body/);
});
