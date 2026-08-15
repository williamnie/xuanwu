import { useEffect, useState } from 'react';
import { Radio } from 'lucide-react';
import { connectorsApi } from '../api/connectors.js';
import './ImChannelRegistryPanel.css';

export default function ImChannelRegistryPanel() {
  const [state, setState] = useState({ channels: [], error: '', loading: true });
  useEffect(() => {
    connectorsApi.getImChannels()
      .then(channels => setState({ channels: Array.isArray(channels) ? channels : [], error: '', loading: false }))
      .catch(error => setState({ channels: [], error: error.message || '读取 IM channel 状态失败', loading: false }));
  }, []);
  return (
    <section className="glass-card im-channel-registry">
      <h2 className="im-channel-registry__heading">
        <Radio size={18} color="var(--primary)" /> IM channels
      </h2>
      <p className="im-channel-registry__description">
        由统一 IM registry 投影接收状态、发送能力和配置入口；新增渠道无需修改此页面的数据结构。
      </p>
      {state.loading && <span>正在读取 IM channel…</span>}
      {state.error && <span className="im-channel-registry__error">{state.error}</span>}
      {!state.loading && !state.error && state.channels.map(channel => (
        <div className="im-channel-registry__channel" key={channel.id}>
          <strong>{channel.display_name || channel.id}</strong>
          <span className="im-channel-registry__meta">
            receiver: {channel.receiver?.state || 'unknown'} · health: {channel.health?.state || 'unknown'}
          </span>
          <span className="im-channel-registry__meta im-channel-registry__meta--wrap">
            {(channel.capabilities || []).join(' · ') || '未声明 capability'}
          </span>
        </div>
      ))}
    </section>
  );
}
