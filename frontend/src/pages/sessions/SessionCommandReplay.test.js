import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import SessionCommandReplay from './SessionCommandReplay.js';

test('renders command replay cards with issue link text', () => {
  const html = renderToStaticMarkup(React.createElement(SessionCommandReplay, {
    history: [
      { id: 1, command_name: 'issue', created_issue_id: 97, result_summary: 'created triage issue #97' },
      { id: 2, command_name: 'run', enqueued_issue_id: 97, result_summary: 'enqueued issue #97' },
    ],
  }));

  assert.match(html, /Command replay/);
  assert.match(html, /\/issue created #97/);
  assert.match(html, /\/run enqueued #97/);
  assert.match(html, /打开 Issue #97/);
});

test('renders failed command replay card', () => {
  const html = renderToStaticMarkup(React.createElement(SessionCommandReplay, {
    history: [{ id: 3, command_name: 'status', error: 'issue not found' }],
  }));

  assert.match(html, /session-command-history-card error/);
  assert.match(html, /\/status failed/);
  assert.match(html, /issue not found/);
});
