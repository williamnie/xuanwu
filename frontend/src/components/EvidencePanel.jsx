import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ChevronRight,
  Download,
  FileCheck2,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { evidenceApi } from '../api/evidence.js';
import {
  decisiveEvidence,
  decisiveEvidenceText,
  evidenceScopeLabel,
  evidenceStatusMeta,
  mergeEvidencePages,
} from './evidencePresentation.js';
import './EvidencePanel.css';

const PAGE_SIZE = 5;

export default function EvidencePanel({
  className = '',
  compact = false,
  issueId = '',
  runId = '',
  sessionRef = '',
  title = '验证证据',
  workId = '',
}) {
  const filters = useMemo(() => ({ issueId, limit: PAGE_SIZE, runId, sessionRef, workId }), [issueId, runId, sessionRef, workId]);
  const [items, setItems] = useState([]);
  const [compatibility, setCompatibility] = useState(null);
  const [nextCursor, setNextCursor] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [downloadError, setDownloadError] = useState('');

  const load = useCallback(async ({ cursor = '', append = false } = {}) => {
    if (append) setLoadingMore(true);
    else setLoading(true);
    try {
      const response = await evidenceApi.listEvidence({ ...filters, cursor });
      setItems(current => append ? mergeEvidencePages(current, response?.items || []) : response?.items || []);
      setCompatibility(response?.compatibility || null);
      setNextCursor(response?.next_cursor || '');
      setError('');
    } catch (loadError) {
      setError(loadError.message || '读取 Evidence 失败');
    } finally {
      if (append) setLoadingMore(false);
      else setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    setItems([]);
    setSelectedId('');
    setDetail(null);
    load();
  }, [load]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailError('');
      return undefined;
    }
    let active = true;
    setDetailLoading(true);
    setDetailError('');
    evidenceApi.getEvidence(selectedId)
      .then(response => {
        if (active) setDetail(response);
      })
      .catch(detailLoadError => {
        if (active) setDetailError(detailLoadError.message || '读取 Evidence 详情失败');
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => { active = false; };
  }, [selectedId]);

  const decisive = decisiveEvidence(items);

  const downloadArtifact = async (artifact, index) => {
    if (!selectedId || !artifact.downloadable) return;
    setDownloadError('');
    try {
      const result = await evidenceApi.downloadArtifact(selectedId, index);
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.filename;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (artifactError) {
      setDownloadError(artifactError.message || '下载 Evidence artifact 失败');
    }
  };

  return (
    <section className={`evidence-panel ${compact ? 'compact' : ''} ${className}`.trim()}>
      <header className="evidence-panel-header">
        <div>
          <span className="evidence-panel-eyebrow"><ShieldCheck size={13} /> System-verifiable</span>
          <h3>{title}</h3>
          <p>{loading && items.length === 0 ? '正在读取决定性事实…' : decisiveEvidenceText(decisive)}</p>
        </div>
        <button aria-label="刷新 Evidence" className="evidence-refresh" disabled={loading} onClick={() => load()} type="button">
          <RefreshCw className={loading ? 'is-spinning' : ''} size={14} />
        </button>
      </header>

      {error ? (
        <div className="evidence-state error" role="alert">
          <AlertTriangle size={16} />
          <span>{error}</span>
          <button onClick={() => load()} type="button">重试</button>
        </div>
      ) : !loading && items.length === 0 ? (
        <div className="evidence-state empty">
          <FileCheck2 size={18} />
          <div><strong>暂无结构化证据</strong><span>Agent 自述、普通评论或 Run success 不会自动算作系统证明。</span></div>
        </div>
      ) : (
        <div className="evidence-list" aria-busy={loading}>
          {items.map(item => (
            <EvidenceRow
              active={selectedId === item.id}
              item={item}
              key={item.id}
              onOpen={() => setSelectedId(current => current === item.id ? '' : item.id)}
            />
          ))}
          {nextCursor ? (
            <button className="evidence-load-more" disabled={loadingMore} onClick={() => load({ cursor: nextCursor, append: true })} type="button">
              {loadingMore ? '加载中…' : '继续加载 Evidence'}
            </button>
          ) : null}
        </div>
      )}

      {selectedId ? (
        <EvidenceDetail
          detail={detail}
          downloadError={downloadError}
          error={detailError}
          loading={detailLoading}
          onDownload={downloadArtifact}
        />
      ) : null}

      {compatibility?.fallback_applied ? (
        <div className="evidence-compatibility">兼容读取：{(compatibility.fallback_sources || []).join(', ')}；仅 structured Evidence 可作为长期主读。</div>
      ) : null}
    </section>
  );
}

function EvidenceRow({ active, item, onOpen }) {
  const status = evidenceStatusMeta(item.status);
  return (
    <button className={`evidence-row ${active ? 'active' : ''}`} onClick={onOpen} type="button">
      <span className={`evidence-status ${status.tone}`}>{status.label}</span>
      <span className="evidence-row-main">
        <strong>{item.decisive_summary || '未提供决定性摘要'}</strong>
        <small>{evidenceScopeLabel(item)} · {formatTimestamp(item.completed_at || item.observed_at)}</small>
      </span>
      {item.artifact_count ? <span className="evidence-artifact-count">{item.artifact_count} artifacts</span> : null}
      <ChevronRight className={active ? 'expanded' : ''} size={15} />
    </button>
  );
}

function EvidenceDetail({ detail, downloadError, error, loading, onDownload }) {
  if (loading) return <div className="evidence-detail-state">正在读取 raw Evidence…</div>;
  if (error) return <div className="evidence-detail-state error" role="alert">{error}</div>;
  if (!detail?.evidence) return null;
  const evidence = detail.evidence;
  return (
    <div className="evidence-detail">
      <div className="evidence-decisive-output">
        <span>决定性输出</span>
        <strong>{evidence.decisive_output?.summary}</strong>
        {evidence.decisive_output?.excerpt ? <pre>{evidence.decisive_output.excerpt}</pre> : null}
      </div>
      {detail.artifacts?.length ? (
        <div className="evidence-artifacts">
          <span>Artifacts</span>
          {detail.artifacts.map((artifact, index) => (
            <button disabled={!artifact.downloadable} key={`${artifact.ref}-${index}`} onClick={() => onDownload(artifact, index)} type="button">
              <Download size={13} /> {artifact.label || artifact.kind || `Artifact ${index + 1}`}
              {!artifact.downloadable ? ` · ${artifact.unavailable_reason || 'unavailable'}` : ''}
            </button>
          ))}
          {downloadError ? <small className="evidence-download-error" role="alert">{downloadError}</small> : null}
        </div>
      ) : null}
      <details className="evidence-raw-details">
        <summary>Raw / advanced</summary>
        <pre>{JSON.stringify({ evidence, storage_source: detail.storage_source }, null, 2)}</pre>
      </details>
    </div>
  );
}

function formatTimestamp(value) {
  if (!value) return '时间未知';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}
