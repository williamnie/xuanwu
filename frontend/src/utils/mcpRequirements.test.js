import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasMcpRequirements,
  issueMcpRequirementSummary,
  mcpRequirementStatus,
} from './mcpRequirements.js';

test('summarizes MCP requirements from API payload and diagnostics', () => {
  const summary = issueMcpRequirementSummary({
    mcp_requirements: {
      diagnostics: [{ code: 'mcp_capability_unregistered', capability_id: 'ghost:resource:missing' }],
      project_allowed: ['docs:resource:runbook'],
      recommended: ['docs:tool:search'],
      required: ['docs:resource:runbook', 'ghost:resource:missing'],
    },
  });

  assert.deepEqual(summary.required, ['docs:resource:runbook', 'ghost:resource:missing']);
  assert.deepEqual(summary.recommended, ['docs:tool:search']);
  assert.deepEqual(summary.projectAllowed, ['docs:resource:runbook']);
  assert.equal(hasMcpRequirements(summary), true);
  assert.equal(mcpRequirementStatus(summary), '1 个 capability 需要诊断');
});

test('falls back to persisted issue MCP JSON fields', () => {
  const summary = issueMcpRequirementSummary({
    recommended_mcp_capabilities: 'docs:tool:search',
    required_mcp_capabilities: '["docs:resource:runbook"]',
  });

  assert.deepEqual(summary.required, ['docs:resource:runbook']);
  assert.deepEqual(summary.recommended, ['docs:tool:search']);
  assert.equal(mcpRequirementStatus(summary), 'MCP requirements 已登记');
});
