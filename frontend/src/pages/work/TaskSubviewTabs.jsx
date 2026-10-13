import { selectAutomations, useDataStore } from '../../store/dataStore';
import './TaskSubviewTabs.css';

// 任务页顶部子视图：任务 | 自动化。仍使用各自现有路由（work / automations），深链不变。
export default function TaskSubviewTabs({ active, navigateTo }) {
  const automations = useDataStore(selectAutomations);
  const activeAutomations = automations.filter(item => item.status === 'active').length;
  return (
    <nav aria-label="任务子视图" className="task-subview-tabs">
      <button aria-current={active === 'work' ? 'page' : undefined} onClick={() => navigateTo('work')} type="button">任务</button>
      <button aria-current={active === 'automations' ? 'page' : undefined} onClick={() => navigateTo('automations')} type="button">
        自动化{automations.length ? <span>{activeAutomations || automations.length}</span> : null}
      </button>
    </nav>
  );
}
