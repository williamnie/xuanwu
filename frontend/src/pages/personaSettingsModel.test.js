import assert from 'node:assert/strict';
import test from 'node:test';

import { personaDirty, personaFormFromSupervisor, personaPatchPayload } from './personaSettingsModel.js';

test('persona saves only persona fields with the revision it was loaded at', () => {
  const form = personaFormFromSupervisor({ name: '玄武', instructions: 'keep', persona: { enabled: 1, personality: '冷静', communication_style: '简洁', verbosity: 'adaptive', language_mode: 'system', revision: 4 } });
  const payload = personaPatchPayload(form);
  assert.deepEqual(Object.keys(payload), ['persona']);
  assert.equal(payload.persona.expected_revision, 4);
  assert.equal(payload.persona.personality, '冷静');
  assert.equal(payload.persona.verbosity, 'adaptive');
});

test('defaults keep persona disabled and adaptive, and dirty tracking ignores the revision', () => {
  const form = personaFormFromSupervisor({});
  assert.deepEqual(form, { communicationStyle: '', enabled: false, languageMode: 'system', personality: '', revision: 0, verbosity: 'adaptive' });
  assert.equal(personaDirty({ ...form, revision: 9 }, form), false);
  assert.equal(personaDirty({ ...form, verbosity: 'concise' }, form), true);
});
