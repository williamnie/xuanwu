import React from 'react';
import { ExternalLink } from 'lucide-react';
import { commandHistoryItems } from './sessionCommandHistory.js';

export default function SessionCommandReplay({ history = [], navigateTo }) {
  const items = commandHistoryItems(history);
  if (!items.length) return null;
  return React.createElement('div', { className: 'session-command-history', 'aria-label': 'Command history' },
    React.createElement('div', { className: 'session-command-history-title' }, 'Command replay'),
    React.createElement('div', { className: 'session-command-history-list' },
      items.map((item) => React.createElement(CommandHistoryCard, { key: item.id, item, navigateTo })),
    ),
  );
}

function CommandHistoryCard({ item, navigateTo }) {
  return React.createElement('div', { className: `session-command-history-card ${item.error ? 'error' : ''}` },
    React.createElement('div', { className: 'session-command-history-main' },
      React.createElement('strong', null, item.title),
      React.createElement('span', null, item.error || item.summary || 'Command completed'),
      item.promptSummary ? React.createElement('small', null, `Prompt: ${item.promptSummary}`) : null,
      item.referencesSummary ? React.createElement('small', null, `Refs: ${item.referencesSummary}`) : null,
    ),
    item.issueId > 0 ? React.createElement('button', {
      type: 'button',
      onClick: () => navigateTo?.('issues', item.issueId),
    }, `打开 Issue #${item.issueId}`, React.createElement(ExternalLink, { size: 12 })) : null,
  );
}
