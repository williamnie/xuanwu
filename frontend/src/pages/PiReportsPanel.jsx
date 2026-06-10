import { useCallback, useEffect, useState } from 'react';
import { FileText, Loader2, RefreshCw } from 'lucide-react';
import { api } from '../api/client';
import { reportTypeLabel } from './piCommandCenterTerms';

const REPORT_LIMIT = 6;

export default function PiReportsPanel() {
  const reports = usePiReports();
  return (
    <section className="pi-command-module pi-reports-panel" aria-label="PI 自动恢复报告">
      <div className="pi-reports-header">
        <div>
          <h2><FileText size={18} /> 自动恢复报告</h2>
          <p>汇总已恢复 issue、限流等待、恢复耗尽和需要人工处理的升级项。</p>
        </div>
        <button className="pi-command-refresh" disabled={reports.loading} onClick={reports.load} type="button">
          {reports.loading ? <Loader2 size={14} className="spin-animation" /> : <RefreshCw size={14} />}
          刷新
        </button>
      </div>
      {reports.error && <div className="pi-command-error" role="alert">{reports.error}</div>}
      <ReportList loading={reports.loading} reports={reports.items} />
    </section>
  );
}

function usePiReports() {
  const [state, setState] = useState({ error: '', items: [], loading: true });
  const load = useCallback(async () => {
    setState(prev => ({ ...prev, error: '', loading: true }));
    try {
      const data = await api.getPiReports({ limit: REPORT_LIMIT });
      setState({ error: '', items: Array.isArray(data) ? data.slice(0, REPORT_LIMIT) : [], loading: false });
    } catch (err) {
      setState(prev => ({ ...prev, error: err.message || '读取 PI 报告失败', loading: false }));
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  return { ...state, load };
}

function ReportList({ loading, reports }) {
  if (loading && reports.length === 0) {
    return <div className="pi-reports-empty"><Loader2 size={14} className="spin-animation" /> 正在读取报告…</div>;
  }
  if (reports.length === 0) return <div className="pi-reports-empty">暂无报告；生成夜间报告或手动报告后可在这里查看汇总。</div>;
  return (
    <div className="pi-reports-list">
      {reports.map(report => <ReportCard key={report.id} report={report} />)}
    </div>
  );
}

function ReportCard({ report }) {
  const supervisor = report.supervisor_summary || {};
  return (
    <article className="pi-reports-card">
      <div className="pi-reports-card-title">
        <strong>#{report.id} {reportTypeLabel(report.type)}</strong>
        <time>{formatTime(report.generated_at)}</time>
      </div>
      <div className="pi-reports-metrics">
        <Metric label="已恢复" value={supervisor.recovered_issues} />
        <Metric label="限流等待" value={supervisor.rate_limit_waits} />
        <Metric label="恢复耗尽" value={supervisor.exhausted_recoveries} />
        <Metric label="需人工处理" value={supervisor.needs_user_escalations} />
      </div>
      <p>
        项目：{report.project_id || '全部'} · Issues：{Array.isArray(report.issue_ids) ? report.issue_ids.length : 0}
      </p>
    </article>
  );
}

function Metric({ label, value }) {
  return (
    <span>
      <strong>{numberText(value)}</strong>
      {label}
    </span>
  );
}

function formatTime(value) {
  const date = new Date(value || '');
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function numberText(value) {
  return String(Number(value || 0));
}
