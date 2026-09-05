import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { systemApi } from '../../api/system.js';
import { effectivenessFacts } from './deliveryEffectivenessModel.js';
import './DeliveryEffectivenessSection.css';

export default function DeliveryEffectivenessSection() {
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    systemApi.getSystemStatus({ force: revision > 0 }).then(response => {
      if (!active) return;
      const data = response?.observability?.delivery_effectiveness;
      if (!data) throw new Error('当前服务尚未提供交付效果统计');
      setSnapshot(data);
      setError('');
    }).catch(failure => {
      if (active) setError(failure.message || '统计暂不可用');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision]);

  return <section className="delivery-effectiveness" aria-label="无人值守效果" aria-busy={loading}>
    <header><div><span>DELIVERY OUTCOMES</span><h3>无人值守效果</h3></div>
      <button className="btn btn-secondary" disabled={loading} onClick={() => setRevision(value => value + 1)} type="button">
        <RefreshCw className={loading ? 'spin-animation' : ''} size={14} /> 刷新统计
      </button>
    </header>
    {error ? <p role="status">{error}{snapshot ? '；下方保留上次统计。' : ''}</p> : null}
    {snapshot ? <>
      <p>近 30 天结束的任务 · {snapshot.sampled_works} 个样本{snapshot.truncated ? '（仅最近 100 个）' : ''} · {snapshot.completed_works} 个完成</p>
      <dl>{effectivenessFacts(snapshot).map(fact => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd><small>{fact.detail}</small></div>)}</dl>
      <details><summary>统计口径与更新时间</summary>
        <p>样本包含已完成、失败和取消的任务。交付要求任务完成、最新交付凭证就绪、关联验证记录且必需交付操作成功。恢复后交付率仅统计有已结束恢复尝试的样本任务。</p>
        <p>“无求助记录”仅指没有审批请求或需用户处理的通知记录，不代表没有任何人工操作。耗时包含从首次执行到最后结束之间的等待时间。</p>
        <p>成本仅包含执行 Agent 上报的金额，不含 Supervisor；任一执行缺少金额时，该任务成本记为未知。不同币种分别统计。</p>
        <p>更新于 {new Date(snapshot.generated_at).toLocaleString()}；服务端统计最多缓存 15 秒。</p>
      </details>
    </> : !error ? <p>{loading ? '正在读取交付统计…' : '暂无统计'}</p> : null}
  </section>;
}
