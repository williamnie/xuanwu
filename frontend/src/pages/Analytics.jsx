import { useState } from 'react';
import DeliveryEffectivenessSection from './command-center/DeliveryEffectivenessSection.jsx';
import CodexUsagePanel from '../components/CodexUsagePanel.jsx';
import './Analytics.css';

export default function Analytics() {
  const [showUsage, setShowUsage] = useState(false);
  return <div className="analytics-page bg-grid-tech">
    <header className="analytics-intro">
      <div className="analytics-intro-kicker font-mono">
        <span>06 TELEMETRY_ANALYTICS</span>
        <span className="text-zinc-500">[METRICS: EVALUATION]</span>
      </div>
      <h1>统计分析</h1>
      <p>查看交付结果、任务耗时和 AI 用量，了解工作完成得怎么样。</p>
    </header>
    <DeliveryEffectivenessSection />
    <details className="analytics-usage" onToggle={event => setShowUsage(event.currentTarget.open)}>
      <summary>查看 AI 用量与账户额度</summary>
      {showUsage ? <CodexUsagePanel /> : null}
    </details>
  </div>;
}
