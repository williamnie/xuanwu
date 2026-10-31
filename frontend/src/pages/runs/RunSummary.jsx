import { RunAdvanced } from './RunEventPanels.jsx';
import { Metric, EmptyState } from './RunDetailPrimitives.jsx';
import { durationText, formatTime } from './runDetailFormat.js';
import { useState } from 'react';
import { History } from 'lucide-react';
import EvidencePanel from '../../components/EvidencePanel.jsx';

import { runPhaseLabel } from './runPhaseLabels.js';

import { runStatusLabel } from './runPageModel.js';
import { runCostView } from './runDetailModel.js';

export default function RunSummary({ attempt, issueId, run }) {
  const progress = run.progress || {};
  const attemptTimeline = (progress.timeline || []).filter(item => !attempt?.id || item.attempt_id === attempt.id);
  const phaseSummary = (progress.phase_summary || []).filter(item => !attempt?.id || item.attempt_id === attempt.id);
  const runCost = runCostView(run.cost);

  return (
    <div className="run-summary-layout">
      <section className="run-summary-main">
        <header className="run-section-heading">
          <div><h2>执行概览</h2><span>整次执行的状态与进展</span></div>
        </header>
        <div className="run-summary-metrics">
          <Metric label="状态" value={runStatusLabel(run.status)} />
          <Metric label="当前阶段" value={runPhaseLabel(progress.provider_phase || progress.phase)} />
          <Metric label="最新进展" value={progress.latest?.summary || run.terminal?.reason || '暂无进展记录'} />
          <Metric label="耗时" value={durationText(run.started_at, run.ended_at)} />
          <Metric label="总 token" value={runCost.total} detail={runCost.completenessLabel} />
          <Metric label="金额" value={runCost.money} />
        </div>
        <section className="run-progress-timeline">
          <div className="run-subsection-title">
            <div><History size={15} /><strong>所选尝试的时间线</strong></div>
            {progress.replay?.timeline_truncated || progress.replay?.source_event_truncated ? <span>仅显示近期记录</span> : null}
          </div>
          {attemptTimeline.length ? attemptTimeline.map(item => (
            <article data-phase={item.phase} key={`${item.attempt_id}:${item.source_event_id}`}>
              <span className="run-timeline-marker" />
              <div>
                <div><strong>{runPhaseLabel(item.phase)}</strong><time>{formatTime(item.occurred_at)}</time></div>
                {item.summary ? <p>{item.summary}</p> : null}
              </div>
            </article>
          )) : phaseSummary.length ? phaseSummary.map(item => (
            <article data-phase={item.phase} key={`${item.attempt_id}:${item.phase}`}>
              <span className="run-timeline-marker" />
              <div><div><strong>{runPhaseLabel(item.phase)}</strong><time>{formatTime(item.last_occurred_at)}</time></div></div>
            </article>
          )) : <EmptyState icon={History} text="这次尝试暂无进展记录。" />}
        </section>
      </section>
      <RunDisclosure title="本次执行验证">
        <EvidencePanel runId={run.id} title="本次执行验证" />
      </RunDisclosure>
      <RunDisclosure title="开发者信息">
        <RunAdvanced attempt={attempt} issueId={issueId} run={run} />
      </RunDisclosure>
    </div>
  );
}

// 仅展开时挂载子组件；原生 details 隐藏内容本身不会停止请求。
function RunDisclosure({ children, title }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="run-summary-disclosure" onToggle={event => setOpen(event.currentTarget.open)} open={open}>
      <summary>{title}</summary>
      {open ? children : null}
    </details>
  );
}

