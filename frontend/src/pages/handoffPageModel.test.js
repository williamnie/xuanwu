import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  deliveryTone,
  handoffCopyText,
  handoffHref,
  handoffReviewActions,
  handoffReviewPayload,
  handoffRouteFromHash,
  handoffRiskPresentation,
  safeExternalUrl,
} from './handoffPageModel.js';

const handoffId = 'xw:handoff:derived:679%40abc123';

test('notification Handoff links round-trip to the exact page identity', () => {
  const href = handoffHref(handoffId);
  assert.equal(href, `#/handoffs/${encodeURIComponent(handoffId)}`);
  assert.deepEqual(handoffRouteFromHash(href), { handoffId, page: 'handoffs' });
  assert.equal(handoffRouteFromHash('#/handoffs/javascript:alert(1)'), null);
  assert.equal(handoffRouteFromHash('#/issues/679'), null);
});

test('copy summary contains delivery refs, Evidence, risk count and next step', () => {
  const text = handoffCopyText({
    handoff: {
      delivery: { branch_ref: 'refs/heads/xw/679', commit_ref: 'abc123', mode: 'branch_commit' },
      evidence_ids: ['xw:evidence:git:679'],
      id: handoffId,
      risks: [{ id: 'generated_files' }],
      status: 'ready',
      summary: 'Focused delivery',
    },
    notification_summary: { next_step: 'Open delivery artifact' },
  });
  assert.match(text, /Branch: refs\/heads\/xw\/679/);
  assert.match(text, /Commit: abc123/);
  assert.match(text, /Evidence: xw:evidence:git:679/);
  assert.match(text, /Risks: 1/);
  assert.match(text, /Next: Open delivery artifact/);
});

test('open actions only accept HTTP(S) URLs and delivery tones remain deterministic', () => {
  assert.equal(safeExternalUrl('https://git.example.test/pulls/1'), 'https://git.example.test/pulls/1');
  assert.equal(safeExternalUrl('javascript:alert(1)'), '');
  assert.equal(deliveryTone('delivered'), 'green');
  assert.equal(deliveryTone('failed'), 'red');
  assert.equal(deliveryTone('sending'), 'amber');
  assert.equal(deliveryTone('approved'), 'green');
  assert.equal(deliveryTone('changes_requested'), 'red');
  assert.equal(deliveryTone('pending'), 'blue');
});

test('review actions follow the current delivery/review state and build audited optimistic writes', () => {
  const pending = {
    handoff: {
      id: handoffId,
      revision: 7,
      review: { state: 'pending' },
      status: 'ready',
    },
    review_summary: { available_actions: ['accept', 'request_changes'], state: 'pending' },
  };
  assert.deepEqual(handoffReviewActions(pending), ['accept', 'request_changes']);
  assert.deepEqual(handoffReviewActions({
    ...pending,
    review_summary: { available_actions: [], state: 'changes_requested' },
  }), []);
  assert.deepEqual(handoffReviewActions({
    ...pending,
    handoff: { ...pending.handoff, status: 'delivered' },
  }), []);

  assert.deepEqual(handoffReviewPayload(pending, 'request_changes', '  Add rollback smoke  ', {
    actorRef: 'user:reviewer',
    nonce: 'fixture-1',
    occurredAt: '2026-07-17T08:30:00.000Z',
  }), {
    action: 'request_changes',
    audit: {
      actor: { id: 'user:reviewer', kind: 'user' },
      correlation_id: `handoff-review:${handoffId}`,
      event_id: 'handoff-review-ui:fixture-1',
      occurred_at: '2026-07-17T08:30:00.000Z',
      reason: 'Add rollback smoke',
    },
    comment: 'Add rollback smoke',
    expected_revision: 7,
  });
  assert.throws(() => handoffReviewPayload(pending, 'request_changes', ''), /requires a comment/);
});

test('risk presentation orders every delivery state by severity without mutating API data', () => {
  const risks = [
    { id: 'low', severity: 'low' },
    { id: 'critical', severity: 'critical' },
    { id: 'high', severity: 'high' },
  ];
  const result = handoffRiskPresentation(risks);
  assert.equal(result.highest, 'critical');
  assert.deepEqual(result.items.map(item => item.id), ['critical', 'high', 'low']);
  assert.deepEqual(result.counts, { critical: 1, high: 1, medium: 0, low: 1 });
  assert.deepEqual(risks.map(item => item.id), ['low', 'critical', 'high']);
});

test('Handoffs stays a lazy page backed by the domain API and sidebar route', () => {
  const app = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');
  const sidebar = readFileSync(new URL('../components/AppSidebar.jsx', import.meta.url), 'utf8');
  const client = readFileSync(new URL('../api/handoffs.js', import.meta.url), 'utf8');
  const page = readFileSync(new URL('./Handoffs.jsx', import.meta.url), 'utf8');
  assert.match(app, /lazy\(\(\) => import\('\.\/pages\/Handoffs'\)\)/);
  assert.match(app, /currentPage === 'handoffs'/);
  assert.match(sidebar, /handoffs: PackageCheck/);
  assert.match(sidebar, /aria-label=\{item\.label\}/);
  assert.match(client, /request\(`\/api\/handoffs\?/);
  assert.match(client, /request\(`\/api\/handoffs\/\$\{encodeURIComponent\(id\)\}`/);
  assert.match(client, /\/api\/handoffs\/\$\{encodeURIComponent\(id\)\}\/reviews/);
  assert.match(page, /title="Diff summary"/);
  assert.match(page, /title="Rollback"/);
  assert.match(page, /Request changes/);
  assert.match(page, /aria-modal="true"/);
});
