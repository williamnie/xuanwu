export type ProjectFindingActionCandidate = {
  action_type: "agent.workflow_request" | "issue.retry_proposal" | "session.steer_proposal";
  payload: Record<string, unknown>;
  rationale: string;
};

export function retryFindingCandidate(issueID: number, reason: string): ProjectFindingActionCandidate {
  return {
    action_type: "issue.retry_proposal",
    payload: { issue_id: issueID },
    rationale: `Retry issue #${issueID} after transient failure: ${reason}`
  };
}

export function verifierWorkflowCandidate(issueID: number): ProjectFindingActionCandidate {
  return {
    action_type: "agent.workflow_request",
    payload: {
      instructions: "Inspect completion evidence, run the minimal verification plan, and write back accept/request_changes.",
      role: "verifier",
      target_issue_id: issueID,
      verification_plan: "Review recorded verification evidence and rerun focused checks if evidence is missing."
    },
    rationale: `Request verifier workflow for pending verification issue #${issueID}.`
  };
}

export function staleSessionSteerCandidate(issueID: number, sessionKey: string): ProjectFindingActionCandidate {
  return {
    action_type: "session.steer_proposal",
    payload: { issue_id: issueID, session_key: sessionKey },
    rationale: `Ask user whether stale issue #${issueID} should be resumed, cancelled, or retried.`
  };
}
