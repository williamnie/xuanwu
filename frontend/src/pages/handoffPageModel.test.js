import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  deliveryTone,
  handoffCopyText,
  handoffHref,
  handoffRouteFromHash,
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
});

test('Handoffs stays a lazy page backed by the domain API and sidebar route', () => {
  const app = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');
  const sidebar = readFileSync(new URL('../components/AppSidebar.jsx', import.meta.url), 'utf8');
  const client = readFileSync(new URL('../api/handoffs.js', import.meta.url), 'utf8');
  assert.match(app, /lazy\(\(\) => import\('\.\/pages\/Handoffs'\)\)/);
  assert.match(app, /currentPage === 'handoffs'/);
  assert.match(sidebar, /aria-label="Handoffs"/);
  assert.match(client, /request\(`\/api\/handoffs\?/);
  assert.match(client, /request\(`\/api\/handoffs\/\$\{encodeURIComponent\(id\)\}`/);
});
