export function commandHistoryItems(history = []) {
  return history.map((item) => {
    const commandName = normalizeCommandName(item.command_name || item.commandName || item.command?.name);
    const issueId = firstPositive(
      item.created_issue_id || item.createdIssueId,
      item.enqueued_issue_id || item.enqueuedIssueId,
      item.target_issue_id || item.targetIssueId,
    );
    return {
      id: item.id || `${commandName}-${item.created_at || ''}-${issueId || ''}`,
      commandName,
      title: commandReplayTitle(commandName, issueId, item),
      summary: item.result_summary || item.resultSummary || '',
      error: item.error || '',
      issueId,
      promptSummary: item.prompt_summary || item.promptSummary || '',
      referencesSummary: item.references_summary || item.referencesSummary || '',
      createdAt: item.created_at || item.createdAt || '',
    };
  });
}

function commandReplayTitle(commandName, issueId, item) {
  const error = item.error || '';
  if (error) return `/${commandName || 'command'} failed`;
  if (commandName === 'issue' && (item.created_issue_id || item.createdIssueId)) {
    return `/issue created #${item.created_issue_id || item.createdIssueId}`;
  }
  if (commandName === 'run' && (item.enqueued_issue_id || item.enqueuedIssueId)) {
    return `/run enqueued #${item.enqueued_issue_id || item.enqueuedIssueId}`;
  }
  if (commandName === 'status' && issueId) {
    return `/status ${item.result_summary || item.resultSummary || `issue #${issueId}`}`;
  }
  return `/${commandName || 'command'} ${item.result_summary || item.resultSummary || 'completed'}`.trim();
}

function normalizeCommandName(value) {
  return String(value || '').replace(/^\//, '').trim().toLowerCase();
}

function firstPositive(...values) {
  for (const value of values) {
    const number = Number(value || 0);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}
