import { isWaitingForProjectNode } from '../utils/remoteProjectStatus.js';
import RemoteProjectBadge from '../components/RemoteProjectBadge.jsx';
import WorkSchedule from './work/WorkSchedule.jsx';
import WorkFeedback from './work/WorkFeedback.jsx';
import { AlertTriangle, ArrowLeft, CircleDot, Copy, LoaderCircle, Pencil, Play, RefreshCw, RotateCw, Square } from 'lucide-react';
import MarkdownPreview from '../components/editor/MarkdownPreview.jsx';
import WorkEditorDialog from './work/WorkEditorDialog.jsx';
import WorkRunList from './work/WorkRunList.jsx';
import { HumanReviewCard } from './work/HumanReview.jsx';
import { workProfileSummary } from './work/workProfileRouting.js';
import WorkDeliveryView from './work/WorkDeliveryView.jsx';
import { WORK_DETAIL_TABS, WORK_TIMELINE_KINDS } from './workDetailModel.js';
import useWorkDetail from './work/useWorkDetail.js';
import { WorkStateSummary, WorkDetailLoading, WorkDetailFailure, SectionHeading, EmptySection, ResourceError, InlineConfirmation } from './work/WorkDetailStates.jsx';
import { formatTime } from './work/workDetailFormatting.js';
import './WorkDetail.css';

export default function WorkDetail({ navigateTo, onPageContextChange, onWorkChanged, projects = [], selectedHandoffId = '', selectedRunId = '', workId }) {
  const {
    nodesById, language, t, detail, work,
    results, resultErrors, latestRun, timelineCursor, timelineKind,
    timelineError, activeTab, runCount, activeDeliveryId, loading,
    resultsLoading, activityLoading, activityLoaded, timelineLoadingMore, refreshing,
    editorOpen, pendingAction, submitting, processToken, error,
    issueId, project, projectName, decision, availableActions,
    blockReason, visibleTimeline, customAcceptance, setActiveTab, setTimelineKind,
    setActiveDeliveryId, setEditorOpen, setPendingAction, refreshAll, loadMoreTimeline,
    submitAction, copyWorkId, handleLatestRunChange, handleRunTotalChange, review,
  } = useWorkDetail({ onPageContextChange, onWorkChanged, projects, selectedHandoffId, selectedRunId, workId });
  if (loading && !work) return <WorkDetailLoading />;
  if (error || !work) return <WorkDetailFailure error={error} navigateTo={navigateTo} />;

  const profileSummary = workProfileSummary(work, latestRun);
  const hasResults = results.handoffs.length > 0 || results.evidence.length > 0 || resultErrors.evidence || resultErrors.handoffs;
  const tabBadges = {
    activity: '',
    description: customAcceptance.length ? String(customAcceptance.length) : '',
    result: results.handoffs.length ? String(results.handoffs.length) : '',
    runs: runCount ? String(runCount) : '',
  };

  return (
    <section className="work-detail-page animate-fade-in">
      <div className="work-detail-toolbar">
        <button className="work-detail-back" onClick={() => navigateTo('tasks')} type="button"><ArrowLeft size={15} /> {t('work.backToBoard')}</button>
        <div className="work-detail-actions">
          {availableActions.start ? <button className="primary" disabled={submitting} onClick={() => submitAction('enqueue')} type="button"><Play size={14} /> {t('work.start')}</button> : null}
          {availableActions.retry ? <button className="primary" disabled={submitting} onClick={() => submitAction('retry')} type="button"><RotateCw size={14} /> {t('work.retry')}</button> : null}
          {availableActions.edit ? <button onClick={() => setEditorOpen(true)} type="button"><Pencil size={14} /> {t('work.edit')}</button> : null}
          {availableActions.cancel ? <button className="danger" disabled={submitting} onClick={() => setPendingAction('cancel')} type="button"><Square size={13} /> {t('work.cancel')}</button> : null}
          <button aria-label={t('work.copyId')} className="icon" onClick={copyWorkId} title={t('work.copyId')} type="button"><Copy size={14} /></button>
          <button aria-label={t('work.refresh')} className="icon" disabled={refreshing} onClick={refreshAll} title={t('work.refresh')} type="button"><RefreshCw className={refreshing ? 'is-spinning' : ''} size={14} /></button>
        </div>
      </div>

      <header className="work-detail-hero">
        <div className="work-detail-eyebrow"><CircleDot size={13} /> TASK{issueId ? ` #${issueId}` : ''}</div>
        <div className="work-detail-title-row">
          <span className="work-detail-status" data-status={work.status}>{t(`status.${work.status}`)}</span>
          <h1>{work.title}</h1>
        </div>
        <div className="work-detail-meta"><span>{projectName}</span><RemoteProjectBadge project={project} nodesById={nodesById} /><span>{t('work.updated', { time: formatTime(work.updated_at, language) })}</span></div>
        {isWaitingForProjectNode(work, project, nodesById) ? <div className="work-block-reason" role="status">等待节点上线</div> : null}
      </header>

      {pendingAction ? <InlineConfirmation busy={submitting} onCancel={() => setPendingAction('')} onConfirm={() => submitAction(pendingAction)} /> : null}

      <section className="work-detail-panel">
        <SectionHeading eyebrow="NOW" title={t('work.sectionNow')} />
        {work.schedule ? <WorkSchedule all work={work} /> : blockReason ? <div className="work-block-reason" role="status"><AlertTriangle size={14} /> {blockReason}</div> : null}
        <WorkStateSummary status={work.status} decision={decision} />
        <WorkFeedback feedback={detail?.feedback} />
        {availableActions.review ? <HumanReviewCard disabled={submitting || review.submitting} onSelect={action => review.select(work, decision.request, action)} request={decision.request} /> : null}
      </section>

      <section className="work-detail-panel work-detail-tabs-panel">
        <div aria-label={t('work.detailTabs')} className="work-detail-tabs" role="tablist">
          {WORK_DETAIL_TABS.map(tab => (
            <button
              aria-controls={`work-detail-tab-${tab}`}
              aria-selected={activeTab === tab}
              id={`work-detail-tabbtn-${tab}`}
              key={tab}
              onClick={() => setActiveTab(tab)}
              role="tab"
              type="button"
            >
              {t(`work.tab.${tab}`)}{tabBadges[tab] ? <span>{tabBadges[tab]}</span> : null}
            </button>
          ))}
        </div>

        <div aria-labelledby="work-detail-tabbtn-result" className="work-detail-tabpanel work-detail-tabpanel-result" hidden={activeTab !== 'result'} id="work-detail-tab-result" role="tabpanel">
          {hasResults ? (
            <WorkDeliveryView
              evidence={results.evidence}
              handoffs={results.handoffs}
              loading={resultsLoading}
              loadError={resultErrors.evidence || resultErrors.handoffs}
              onRefresh={refreshAll}
              onSelectionChange={setActiveDeliveryId}
              selectedHandoffId={activeDeliveryId}
              work={work}
            />
          ) : resultsLoading ? (
            <div className="work-section-empty"><LoaderCircle className="is-spinning" size={16} /><span>{t('work.loadingResult')}</span></div>
          ) : <EmptySection text={t('work.noResult')} />}
        </div>

        <div aria-labelledby="work-detail-tabbtn-description" className="work-detail-tabpanel" hidden={activeTab !== 'description'} id="work-detail-tab-description" role="tabpanel">
          <div className="work-detail-description"><MarkdownPreview text={work.goal || t('work.noGoal')} /></div>
          {customAcceptance.length ? (
            <div className="work-detail-acceptance">
              <h3>{t('work.acceptanceCriteria')}</h3>
              <ul>{customAcceptance.map(criterion => <li key={criterion.id}>{criterion.description}</li>)}</ul>
            </div>
          ) : null}
        </div>

        <div aria-labelledby="work-detail-tabbtn-runs" className="work-detail-tabpanel" hidden={activeTab !== 'runs'} id="work-detail-tab-runs" role="tabpanel">
          <WorkRunList
            navigateTo={navigateTo}
            onLatestRunChange={handleLatestRunChange}
            onTotalChange={handleRunTotalChange}
            refreshToken={processToken}
            selectedRunId={selectedRunId}
            workId={workId}
          />
          <details className="work-detail-disclosure">
            <summary>{t('work.executionConfig')}</summary>
            <dl className="work-provider-profile-facts">
              <div><dt>{t('work.profile.preset')}</dt><dd>{profileSummary.effectiveProfile}</dd></div>
              <div><dt>{t('work.profile.provider')}</dt><dd>{profileSummary.effectiveProvider}</dd></div>
              <div><dt>{t('work.profile.model')}</dt><dd>{profileSummary.effectiveModel}</dd></div>
              <div><dt>{t('work.profile.source')}</dt><dd>{profileSummary.sourceLabel}</dd></div>
              <div><dt>{t('work.profile.actual')}</dt><dd>{profileSummary.runProvider}</dd></div>
            </dl>
          </details>
        </div>

        <div aria-labelledby="work-detail-tabbtn-activity" className="work-detail-tabpanel" hidden={activeTab !== 'activity'} id="work-detail-tab-activity" role="tabpanel">
          <div className="work-timeline-filters" role="group" aria-label={t('work.activityKind')}>
            <button aria-pressed={!timelineKind} onClick={() => setTimelineKind('')} type="button">{t('work.all')}</button>
            {WORK_TIMELINE_KINDS.map(kind => <button aria-pressed={timelineKind === kind} key={kind} onClick={() => setTimelineKind(kind)} type="button">{t(`timeline.${kind}`)}</button>)}
          </div>
          <ResourceError error={timelineError} />
          {activityLoading && !activityLoaded ? <div className="work-activity-loading"><LoaderCircle className="is-spinning" size={14} /> {t('work.loadingActivity')}</div> : null}
          {activityLoaded && !activityLoading && visibleTimeline.length === 0 ? <EmptySection text={timelineCursor ? t('work.noVisibleActivityYet') : timelineKind ? t('work.noMatchingActivity') : t('work.noActivity')} /> : null}
          <div className="work-timeline-list">
            {visibleTimeline.map(item => (
              <article key={item.id}>
                <span className="work-timeline-marker" data-kind={item.kind} />
                <div><div><strong>{item.title}</strong><em>{item.status}</em></div><p>{item.summary}</p><span>{t(`timeline.${item.kind}`)} · {formatTime(item.occurred_at, language)}</span></div>
              </article>
            ))}
          </div>
          {timelineCursor ? <button className="work-timeline-more" disabled={timelineLoadingMore} onClick={loadMoreTimeline} type="button">{timelineLoadingMore ? <LoaderCircle className="is-spinning" size={14} /> : null}{timelineLoadingMore ? t('work.loadingEarlier') : t('work.loadEarlier')}</button> : null}
        </div>
      </section>

      {editorOpen ? <WorkEditorDialog mode="edit" onClose={() => setEditorOpen(false)} onSaved={async () => { setEditorOpen(false); await refreshAll(); onWorkChanged?.(); }} projects={projects} work={work} /> : null}
      {review.dialog}
    </section>
  );
}
