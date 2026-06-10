import { useCallback, useEffect, useState } from 'react';
import { FileText, Loader2, RefreshCw } from 'lucide-react';
import { api } from '../api/client';

const REPORT_LIMIT = 6;

export default function PiReportsPanel() {
  const reports = usePiReports();
  return (
    <section className="pi-command-module pi-reports-panel" aria-label="PI supervisor reports">
      <div className="pi-reports-header">
        <div>
          <h2><FileText size={18} /> Reports</h2>
          <p>汇总 recovered issues、rate-limit waits、exhausted recoveries 与 needs_user escalations。</p>
        </div>
        <button className="pi-command-refresh" disabled={reports.loading} onClick={reports.load} type="button">
          {reports.loading ? <Loader2 size={14} className="spin-animation" /> : <RefreshCw size={14} />}
          Refresh
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
      setState(prev => ({ ...prev, error: err.message || '读取 PI reports 失败', loading: false }));
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  return { ...state, load };
}

function ReportList({ loading, reports }) {
  if (loading && reports.length === 0) {
    return <div className="pi-reports-empty"><Loader2 size={14} className="spin-animation" /> 正在读取 reports…</div>;
  }
  if (reports.length === 0) return <div className="pi-reports-empty">暂无 report；可从 night/manual report 生成后查看汇总。</div>;
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
        <strong>#{report.id} {report.type}</strong>
        <time>{formatTime(report.generated_at)}</time>
      </div>
      <div className="pi-reports-metrics">
        <Metric label="Recovered" value={supervisor.recovered_issues} />
        <Metric label="429 waits" value={supervisor.rate_limit_waits} />
        <Metric label="Exhausted" value={supervisor.exhausted_recoveries} />
        <Metric label="Needs user" value={supervisor.needs_user_escalations} />
      </div>
      <p>
        Project: {report.project_id || 'all'} · Issues: {Array.isArray(report.issue_ids) ? report.issue_ids.length : 0}
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
