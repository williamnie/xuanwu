import DeliveryEffectivenessSection from './command-center/DeliveryEffectivenessSection.jsx';
import CodexUsagePanel from '../components/CodexUsagePanel.jsx';
import './Analytics.css';

export default function Analytics() {
  return <div className="analytics-page bg-grid-tech">
    <header className="analytics-intro">
      <div className="analytics-intro-kicker font-mono"><span>05 TELEMETRY_ANALYTICS</span></div>
      <h1>统计分析</h1>
      <p>任务交付得怎么样，AI 用了多少。</p>
    </header>
    <DeliveryEffectivenessSection />
    <CodexUsagePanel />
  </div>;
}
