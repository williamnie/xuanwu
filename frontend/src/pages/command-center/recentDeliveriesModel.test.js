import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  mergeRecentDeliveryDetail,
  recentDeliveryDetailRoute,
  recentDeliveryView,
} from './recentDeliveriesModel.js';

const HANDOFF_ID = 'xw:handoff:derived:697%40abc123';
const WORK_ID = 'xw:work:issues:697';
const styles = readFileSync(new URL('./RecentDeliveriesSection.css', import.meta.url), 'utf8');

test('Recent Deliveries presents every Handoff mode with its authoritative refs', () => {
  const modes = [
    ['local_changes', { working_tree_ref: 'git:tree' }, 'Working tree', '本地改动快照'],
    ['branch_commit', { branch_ref: 'refs/heads/xw/697', commit_ref: 'abc123' }, 'Commit', '本地分支与 commit'],
    ['push', { branch_ref: 'refs/heads/xw/697', commit_ref: 'abc123', remote_ref: 'origin/xw/697' }, 'Remote', '已推送远端'],
    ['draft_pr', prDelivery(), 'Pull request', '草稿 PR'],
    ['ready_pr', prDelivery(), 'Pull request', '待评审 PR'],
    ['deploy', { deployment_ref: 'deploy:697', environment: 'staging', revision_ref: 'abc123' }, 'Deployment', '部署'],
    ['release', { release_ref: 'release:697', revision_ref: 'abc123', version: '1.2.3' }, 'Release', '发布'],
  ];

  for (const [mode, delivery, primaryLabel, modeLabel] of modes) {
    const view = recentDeliveryView(item({ delivery: { mode, ...delivery } }));
    assert.equal(view.modeLabel, modeLabel, mode);
    assert.equal(view.refs.at(-1).label, primaryLabel, mode);
    assert.ok(view.primaryRef, mode);
  }
});

test('Evidence, review, delivery and risk conclusions stay deterministic', () => {
  const view = recentDeliveryView(item({
    delivery: { mode: 'ready_pr', ...prDelivery() },
    delivery_status: { overall: 'delivering', refreshed_at: '2026-07-17T08:01:00.000Z' },
    evidence_count: 3,
    review: { state: 'approved' },
    risk_count: 1,
    status: 'ready',
  }));
  assert.equal(view.evidenceLabel, '3 Evidence passed');
  assert.equal(view.evidencePassed, true);
  assert.equal(view.reviewLabel, 'Review approved');
  assert.equal(view.statusLabel, '交付中');
  assert.equal(view.statusTone, 'amber');
  assert.equal(view.riskLabel, '1 risk');
  assert.equal(view.externalHref, 'https://git.example.test/pulls/697');
});

test('detail refresh replaces aggregate status without replacing API-owned links', () => {
  const snapshot = item({ status: 'draft' });
  const refreshed = mergeRecentDeliveryDetail(snapshot, {
    delivery_status: { overall: 'delivered', refreshed_at: '2026-07-17T08:02:00.000Z' },
    handoff: {
      delivery: { mode: 'deploy', deployment_ref: 'deploy:697', environment: 'staging', revision_ref: 'abc123' },
      evidence_ids: ['xw:evidence:git:697'],
      id: HANDOFF_ID,
      review: { state: 'not_applicable' },
      risks: [],
      status: 'delivered',
      summary: 'Deployed verified revision',
      updated_at: '2026-07-17T08:02:00.000Z',
    },
  });
  assert.equal(refreshed.delivery_status.overall, 'delivered');
  assert.equal(refreshed.status, 'delivered');
  assert.equal(refreshed.evidence_count, 1);
  assert.equal(refreshed.links, snapshot.links);
  assert.equal(recentDeliveryView(refreshed).operationLabel, 'Deploy');
});

test('open actions accept only the returned matching Handoff link and HTTP(S) URL', () => {
  const valid = item();
  assert.deepEqual(recentDeliveryDetailRoute(valid), { handoffId: HANDOFF_ID, page: 'work', workId: WORK_ID });
  assert.equal(recentDeliveryDetailRoute(item({ links: { view: '#/handoffs/xw%3Ahandoff%3Aderived%3Aother' } })), null);
  assert.equal(recentDeliveryView(item({
    delivery: { mode: 'ready_pr', ...prDelivery(), url: 'javascript:alert(1)' },
  })).externalHref, '');
});

test('Dashboard trusts the aggregate Handoff status without per-card hydration or a write path', () => {
  const page = readFileSync(new URL('./RecentDeliveriesSection.jsx', import.meta.url), 'utf8');
  const dashboard = readFileSync(new URL('../Dashboard.jsx', import.meta.url), 'utf8');
  assert.match(page, /sections: \['recent_deliveries'\]/);
  assert.doesNotMatch(page, /handoffsApi\.getHandoff\(item\.id\)/);
  assert.match(page, /event\.type !== 'handoff\.notification'/);
  assert.match(page, /REFRESH_INTERVAL_MS = 30_000/);
  assert.match(page, /navigator\.clipboard\.writeText/);
  assert.match(page, /history\?\.replaceState\?\.\(null, '', item\.links\.view\)/);
  assert.match(page, /navigateTo\?\.\(route\.page, route\.workId \|\| item\.work_id, '', route\.handoffId\)/);
  assert.doesNotMatch(page, /createHandoff|updateHandoff|controlWork|controlRun/);
  assert.match(dashboard, /<RecentDeliveriesSection navigateTo=\{navigateTo\} projects=\{projects\} \/>/);
});

test('Recent Deliveries keeps expanded cards inside a keyboard-scrollable region', () => {
  const page = readFileSync(new URL('./RecentDeliveriesSection.jsx', import.meta.url), 'utf8');
  const listRule = styles.match(/\.recent-deliveries-list\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(page, /aria-label="最近交付列表"/);
  assert.match(page, /role="region"/);
  assert.match(page, /tabIndex=\{0\}/);
  assert.match(listRule, /max-height:\s*min\(68vh, 640px\)/);
  assert.match(listRule, /overflow-y:\s*auto/);
  assert.match(listRule, /overscroll-behavior:\s*contain/);
});

function item(overrides = {}) {
  return {
    delivery: { mode: 'branch_commit', branch_ref: 'refs/heads/xw/697', commit_ref: 'abc123' },
    evidence_count: 0,
    id: HANDOFF_ID,
    links: { view: `#/work/${encodeURIComponent(WORK_ID)}/delivery/${encodeURIComponent(HANDOFF_ID)}` },
    project_id: 'xuanwu',
    review: { state: 'not_requested' },
    risk_count: 0,
    status: 'draft',
    summary: 'Recent delivery fixture',
    updated_at: '2026-07-17T08:00:00.000Z',
    work_id: WORK_ID,
    ...overrides,
  };
}

function prDelivery() {
  return {
    branch_ref: 'refs/heads/xw/697',
    commit_ref: 'abc123',
    pull_request_ref: 'pull:697',
    remote_ref: 'origin/xw/697',
    url: 'https://git.example.test/pulls/697',
  };
}
