import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  deliveryTone,
  handoffCopyText,
  handoffHref,
  handoffRouteFromHash,
  handoffRiskPresentation,
  safeExternalUrl,
} from './handoffPageModel.js';

const handoffId = 'xw:handoff:derived:679%40abc123';
const workId = 'xw:work:issues:679';

test('notification Handoff links open the exact delivery inside its Work', () => {
  const href = handoffHref(handoffId, workId);
  assert.equal(href, `#/work/${encodeURIComponent(workId)}/delivery/${encodeURIComponent(handoffId)}`);
  assert.deepEqual(handoffRouteFromHash(href), { handoffId, page: 'work', workId });
  assert.deepEqual(handoffRouteFromHash(handoffHref(handoffId)), { handoffId, page: 'handoffs' });
  assert.equal(handoffRouteFromHash('#/handoffs/javascript:alert(1)'), null);
  assert.equal(handoffRouteFromHash('#/work/javascript%3Aalert(1)/delivery/xw%3Ahandoff%3Aderived%3A679'), null);
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

test('Handoff stays available for audit while normal delivery lives inside Work Detail', () => {
  const app = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');
  const sidebar = readFileSync(new URL('../components/AppSidebar.jsx', import.meta.url), 'utf8');
  const client = readFileSync(new URL('../api/handoffs.js', import.meta.url), 'utf8');
  const page = readFileSync(new URL('./Handoffs.jsx', import.meta.url), 'utf8');
  const workDetail = readFileSync(new URL('./WorkDetail.jsx', import.meta.url), 'utf8');
  assert.match(app, /lazy\(\(\) => import\('\.\/pages\/Handoffs'\)\)/);
  assert.match(app, /currentPage === 'handoffs'/);
  assert.doesNotMatch(sidebar, /handoffs: PackageCheck/);
  assert.match(sidebar, /aria-label=\{navLabel\(item\)\}/);
  assert.match(client, /request\(`\/api\/handoffs\?/);
  assert.match(client, /request\(`\/api\/handoffs\/\$\{encodeURIComponent\(id\)\}`/);
  assert.match(workDetail, /<WorkDeliveryView/);
  assert.match(workDetail, /\{t\('work\.delivery'\)\} \{overview\.handoffs\.length/);
  assert.doesNotMatch(workDetail, /navigateTo\('handoffs'/);
  assert.match(page, /Handoff 审计/);
  assert.match(page, /打开所属 Issue 交付/);
  assert.match(page, /title="Diff summary"/);
  assert.match(page, /title="Rollback"/);
});
