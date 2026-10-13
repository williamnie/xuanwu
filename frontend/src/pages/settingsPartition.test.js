import { expect, test } from 'bun:test';
import { DEFAULT_PI_AGENT_FORM, connectionSelectionPayload, runtimePreferencePayload, supervisorPayload, inferApiProtocol } from './piAgentSettingsState.js';
import { normalizeGitHubSnapshot } from '../api/githubSettings.js';

test('each assistant setting domain sends only the fields it owns',()=>{
  const form={...DEFAULT_PI_AGENT_FORM,apiKey:'unsaved-key',instructions:'unsaved instructions',personaDirty:true,personaPersonality:'old personality',personaRevision:7};
  expect(Object.keys(connectionSelectionPayload(form)).sort()).toEqual(['model_id','model_provider']);
  expect(Object.keys(runtimePreferencePayload(form)).sort()).toEqual(['enabled','instructions','name','thinking_level']);
  const persona=supervisorPayload(form).persona;
  expect(persona.expected_revision).toBe(7);expect(persona.personality).toBe('old personality');expect(persona.api_key).toBeUndefined();
});
test('protocol preselection uses the runtime catalogue and leaves unknown addresses alone',()=>{
  const presets=[{base_url:'https://api.fixture.example/v1',api:'anthropic',auth:'api-key'}];
  expect(inferApiProtocol('https://api.fixture.example/v1/messages',presets)).toBe('anthropic');
  expect(inferApiProtocol('https://custom.example/v1',presets)).toBe('');
});
test('partial GitHub metadata cannot crash or falsely claim an applied configuration',()=>{
  expect(()=>normalizeGitHubSnapshot({})).toThrow();
  const snapshot=normalizeGitHubSnapshot({revision:'one',settings:{auth:{mode:'gh-cli'},repositories:[]}});
  expect(snapshot.application.status).toBe('unknown');expect(snapshot.projects).toEqual([]);
});
