import { Bot, CircleDot, Compass } from 'lucide-react';

export function AssistantOverviewPanel() {
  const items = [
    '一个 PI Assistant 统一承载 Runtime、Connectors、Skills、Automations 与 Memory。',
    '当前先保留已有模型、thinking、instructions、OAuth 与 enabled 配置。',
    '后续能力只作为这个 Assistant 的能力区，不恢复多个独立 PI agent。'
  ];
  return (
    <section className="glass-card" style={{ display: 'grid', gap: '14px' }}>
      <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
        <Bot size={20} color="var(--primary)" />
        <div>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.74rem', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            Single Assistant Runtime
          </div>
          <h2 style={{ fontSize: '1.15rem', fontWeight: 800 }}>PI Assistant</h2>
        </div>
      </div>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.86rem', lineHeight: 1.6, margin: 0 }}>
        Assistant Settings 是唯一 PI Assistant 的设置中心：Runtime 负责当前 issue/session 编排；
        Connectors、Skills、Automations、Approvals、Memory、Activity 与 Policies 会逐步挂到同一个 Assistant 下。
      </p>
      <BulletList items={items} />
    </section>
  );
}

export function SettingsPlaceholderPanel({ title, eyebrow, description, items = [] }) {
  return (
    <section className="glass-card" style={{ display: 'grid', gap: '12px' }}>
      <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
        <Compass size={18} color="var(--primary)" />
        <div>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            {eyebrow}
          </div>
          <h2 style={{ fontSize: '1.05rem', fontWeight: 800 }}>{title}</h2>
        </div>
      </div>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.84rem', lineHeight: 1.6, margin: 0 }}>
        {description}
      </p>
      <BulletList items={items} />
    </section>
  );
}

function BulletList({ items }) {
  if (!items.length) return null;
  return (
    <div style={{ display: 'grid', gap: '8px' }}>
      {items.map((item) => (
        <div key={item} style={{ color: 'var(--text-muted)', display: 'flex', gap: '8px', fontSize: '0.8rem', lineHeight: 1.5 }}>
          <CircleDot size={13} color="var(--primary)" style={{ marginTop: '3px', flex: '0 0 auto' }} />
          <span>{item}</span>
        </div>
      ))}
    </div>
  );
}
