import { useEffect, useState } from 'react';
import { ArrowLeft, XCircle } from 'lucide-react';
import IssueEditModal from '../components/IssueEditModal';
import { deriveIssueExecutionSummary } from '../utils/issueExecutionSummary';
import { summarizeAgentProfile } from '../utils/agentProfiles';
import { issueMcpRequirementSummary } from '../utils/mcpRequirements';
import IssueDetailOverview, { IssueStatusAlerts } from './issue-detail/IssueDetailOverview';
import IssueDetailRuns from './issue-detail/IssueDetailRuns';
import IssueDetailEvidence, { CurrentSupervisorEvidence } from './issue-detail/IssueDetailEvidence';
import {
  IssueActivityTimeline,
  IssueDetailTabs,
  IssueLogTimeline,
} from './issue-detail/IssueDetailTimeline';
import IssueDetailComments from './issue-detail/IssueDetailComments';
import IssueDetailDecision, { HumanReviewResponseModal } from './issue-detail/IssueDetailDecision';
import IssueDetailActions, {
  IssueDeleteConfirmModal,
  IssueManualControls,
} from './issue-detail/IssueDetailActions';
import useIssueDetailData from './issue-detail/useIssueDetailData';
import useIssueDetailActions from './issue-detail/useIssueDetailActions';
import {
  issueExecutionSessionRef,
  issueProviderIdentity,
  providerLabel,
  supervisorHasSignal,
  supervisorNeedsAttention,
} from './issue-detail/issueDetailFormatters';
import './IssueDetail.css';

export default function IssueDetail({ issueId, navigateTo }) {
  const [activeTab, setActiveTab] = useState('activity');
  const detail = useIssueDetailData(issueId, activeTab);
  const {
    issue,
    project,
    events,
    logEvents,
    logsLoaded,
    logsLoading,
    logsHasMore,
    logsError,
    unseenLogCount,
    runs,
    profiles,
    supervisor,
    loading,
    error,
    loadIssueData,
    loadIssueLogs,
    updateDetailState,
  } = detail;
  const actions = useIssueDetailActions({
    issueId,
    issue,
    navigateTo,
    loadIssueData,
    updateDetailState,
  });

  useEffect(() => {
    setActiveTab('activity');
  }, [issueId]);

  if (loading && !issue) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '60vh', gap: '16px' }}>
        <div style={{ width: '40px', height: '40px', border: '3px solid var(--border-color)', borderTopColor: 'var(--primary)', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
        <p style={{ color: 'var(--text-secondary)' }}>载入任务详情中...</p>
      </div>
    );
  }

  if (error || !issue) {
    return (
      <div className="glass-card" style={{ borderLeft: '4px solid var(--error)', padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <XCircle color="var(--error)" size={24} />
          <h3 style={{ fontSize: '1.2rem', fontWeight: 600 }}>任务加载失败</h3>
        </div>
        <p style={{ color: 'var(--text-secondary)' }}>{error || '找不到请求的 Issue 任务数据。'}</p>
        <button className="btn btn-secondary" style={{ alignSelf: 'flex-start' }} onClick={() => navigateTo('issues')}>
          <ArrowLeft size={16} /> 返回任务队列
        </button>
      </div>
    );
  }

  const commentEvents = events.filter(event => event.type === 'issue.comment');
  const runtimeIdentity = issueProviderIdentity(issue, runs);
  const runtimeProvider = providerLabel(runtimeIdentity.provider);
  const executionSummary = deriveIssueExecutionSummary({ issue, events, runs });
  const profileSummary = summarizeAgentProfile(project?.default_agent_profile);
  const mcpSummary = issueMcpRequirementSummary(issue);
  const latestRun = executionSummary.latestRun;
  const executionSessionRef = issueExecutionSessionRef(issue, latestRun, runtimeIdentity);
  const hasSupervisorHistory = supervisorHasSignal(supervisor);
  const hasCurrentSupervisorSignal = supervisorNeedsAttention(supervisor, issue);

  return (
    <div className="issue-detail-page animate-fade-in">
      <IssueDetailActions
        issue={issue}
        onBack={() => navigateTo('issues')}
        onEdit={() => actions.setIsEditModalOpen(true)}
        onMoveToTodo={actions.handleMoveToTodo}
        onCancel={actions.handleCancel}
        onRetry={actions.handleRetry}
        onShowAdvanced={() => setActiveTab('advanced')}
        onDelete={() => actions.setDeleteConfirmOpen(true)}
      />

      {actions.deleteConfirmOpen && (
        <IssueDeleteConfirmModal
          issue={issue}
          deleting={actions.deletingIssue}
          onCancel={() => actions.setDeleteConfirmOpen(false)}
          onConfirm={actions.handleDelete}
        />
      )}

      {actions.humanReviewAction && (
        <HumanReviewResponseModal
          action={actions.humanReviewAction}
          draft={actions.humanReviewDraft}
          request={issue.decision?.request}
          submitting={actions.humanReviewSubmitting}
          onDraftChange={actions.setHumanReviewDraft}
          onCancel={() => actions.setHumanReviewAction('')}
          onConfirm={() => actions.handleHumanReviewResponse(
            actions.humanReviewAction,
            actions.humanReviewDraft,
          )}
        />
      )}

      <IssueDetailOverview
        issue={issue}
        project={project}
        latestRun={latestRun}
        executionSummary={executionSummary}
        executionSessionRef={executionSessionRef}
        navigateTo={navigateTo}
        onEdit={() => actions.setIsEditModalOpen(true)}
      />

      <IssueStatusAlerts
        issue={issue}
        executionSummary={executionSummary}
        onShowRuns={() => setActiveTab('runs')}
        onShowLogs={() => setActiveTab('logs')}
      />

      {issue.status === 'needs_user' && (
        <IssueDetailDecision
          evidence={issue.error}
          decision={issue.decision}
          onAccept={() => actions.setHumanReviewAction('accept')}
          onReject={() => actions.setHumanReviewAction('reject')}
          onRequestChanges={() => actions.setHumanReviewAction('request_changes')}
        />
      )}

      <CurrentSupervisorEvidence supervisor={supervisor} visible={hasCurrentSupervisorSignal} />

      <section className="issue-detail-workspace glass-card">
        <IssueDetailTabs
          activeTab={activeTab}
          events={events}
          logsLoaded={logsLoaded}
          logEvents={logEvents}
          unseenLogCount={unseenLogCount}
          runs={runs}
          onChange={setActiveTab}
        />

        <div className="issue-detail-tab-panel" role="tabpanel">
          {activeTab === 'activity' && (
            <div className="issue-activity-grid">
              <IssueActivityTimeline events={events} />
              <IssueDetailComments
                count={commentEvents.length}
                draft={actions.commentDraft}
                error={actions.commentError}
                submitting={actions.commentSubmitting}
                sessionRef={executionSessionRef}
                navigateTo={navigateTo}
                onDraftChange={actions.setCommentDraft}
                onSubmit={actions.handleSubmitComment}
              />
            </div>
          )}

          <IssueLogTimeline
            activeTab={activeTab}
            project={project}
            runtimeProvider={runtimeProvider}
            runtimeIdentity={runtimeIdentity}
            logEvents={logEvents}
            logsLoaded={logsLoaded}
            logsLoading={logsLoading}
            logsHasMore={logsHasMore}
            logsError={logsError}
            loadIssueLogs={loadIssueLogs}
          />

          {activeTab === 'runs' && (
            <IssueDetailRuns
              issue={issue}
              project={project}
              profiles={profiles}
              runs={runs}
              currentStatus={issue.status}
              navigateTo={navigateTo}
              onCopy={actions.handleCopyText}
            />
          )}

          {activeTab === 'advanced' && (
            <div className="issue-advanced-grid">
              <IssueDetailEvidence
                issue={issue}
                profileSummary={profileSummary}
                runtimeIdentity={runtimeIdentity}
                runtimeProvider={runtimeProvider}
                mcpSummary={mcpSummary}
                supervisor={supervisor}
                hasSupervisorHistory={hasSupervisorHistory}
                hasCurrentSupervisorSignal={hasCurrentSupervisorSignal}
                onServiceTierChange={actions.handleServiceTierChange}
                onIssueLogModeChange={actions.handleIssueLogModeChange}
                actionControls={(
                  <IssueManualControls issue={issue} onMarkStatus={actions.handleMarkStatus} />
                )}
              />
            </div>
          )}
        </div>
      </section>

      {actions.isEditModalOpen && (
        <IssueEditModal
          issue={issue}
          onClose={actions.closeEditModal}
          onSaved={actions.handleIssueSaved}
        />
      )}
    </div>
  );
}
