import { useEffect, useState } from 'react';
import { evidenceApi } from '../../api/evidence.js';
import { useI18n } from '../../i18n/context.js';
import './WorkDeliveryEvidence.css';

export default function WorkDeliveryEvidence({ id, workId }) {
  const { language } = useI18n();
  const english = language === 'en-US';
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open) return undefined;
    let active = true;
    setDetail(null);
    setError('');
    evidenceApi.getEvidence(id).then(value => {
      if (!active) return;
      if (value?.evidence?.id !== id || value.evidence.work_id !== workId) throw new Error('Evidence scope mismatch');
      setDetail(value);
    }).catch(cause => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [id, open, retry, workId]);

  const download = async (index) => {
    try {
      const result = await evidenceApi.downloadArtifact(id, index);
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.filename;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (cause) { setError(cause.message); }
  };

  return <div className="work-delivery-evidence-detail">
    <code>{id}</code>
    <button aria-expanded={open} onClick={() => setOpen(value => !value)} type="button">{open ? (english ? 'Hide evidence' : '收起证据') : (english ? 'View evidence' : '查看证据')}</button>
    {open ? <div>
      {error ? <p role="alert">{error} <button onClick={() => setRetry(value => value + 1)} type="button">{english ? 'Retry' : '重试'}</button></p> : !detail ? <p role="status">{english ? 'Loading evidence…' : '正在读取证据…'}</p> : null}
      {detail ? <>
        <p>{detail.evidence.status} · {detail.evidence.decisive_output?.summary}</p>
        {Number.isInteger(detail.evidence.decisive_output?.exit_code) ? <p>Exit code: {detail.evidence.decisive_output.exit_code}</p> : null}
        {detail.evidence.decisive_output?.excerpt ? <pre>{detail.evidence.decisive_output.excerpt}</pre> : null}
        {(detail.artifacts || []).map((artifact, index) => <button disabled={!artifact.downloadable} key={`${artifact.ref}-${index}`} onClick={() => download(index)} type="button">{artifact.label || artifact.kind || 'Artifact'}{!artifact.downloadable ? ` · ${artifact.unavailable_reason || (english ? 'Unavailable' : '不可用')}` : ''}</button>)}
      </> : null}
    </div> : null}
  </div>;
}
