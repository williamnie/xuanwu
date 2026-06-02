import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const skillSource = readFileSync(new URL('../../../skills/codex-issue-runner/SKILL.md', import.meta.url), 'utf8');

test('codex issue runner skill documents protected issue delete command', () => {
  assert.match(skillSource, /issue delete --addr/);
  assert.match(skillSource, /physically removes the issue/);
  assert.match(skillSource, /in_progress/);
});
