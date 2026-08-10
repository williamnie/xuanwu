import { useEffect, useState } from 'react';
import { Radio } from 'lucide-react';
import { connectorsApi } from '../api/connectors.js';

export default function ImChannelRegistryPanel() {
  const [state, setState] = useState({ channels: [], error: '', loading: true });
  useEffect(() => {
    connectorsApi.getImChannels()
      .then(channels => setState({ channels: Array.isArray(channels) ? channels : [], error: '', loading: false }))
      .catch(error => setState({ channels: [], error: error.message || '读取 IM channel 状态失败', loading: false }));
  }, []);
  return (
    <section className="glass-card" style={{ display: 'grid', gap: '12px' }}>
      <h2 style={{ alignItems: 'center', display: 'flex', fontSize: '1.1rem', gap: '8px' }}>
        <Radio size={18} color="var(--primary)" /> IM channels
      </h2>
      <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>
        由统一 IM registry 投影接收状态、发送能力和配置入口；新增渠道无需修改此页面的数据结构。
      </p>
      {state.loading && <span>正在读取 IM channel…</span>}
      {state.error && <span style={{ color: 'var(--error)' }}>{state.error}</span>}
      {!state.loading && !state.error && state.channels.map(channel => (
        <div key={channel.id} style={{ border: '1px solid var(--border-light)', borderRadius: '12px', display: 'grid', gap: '6px', padding: '12px' }}>
          <strong>{channel.display_name || channel.id}</strong>
          <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>
            receiver: {channel.receiver?.state || 'unknown'} · health: {channel.health?.state || 'unknown'}
          </span>
          <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem', wordBreak: 'break-word' }}>
            {(channel.capabilities || []).join(' · ') || '未声明 capability'}
          </span>
        </div>
      ))}
    </section>
  );
}
