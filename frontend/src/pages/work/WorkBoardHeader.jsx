import { projectOptionLabel } from '../../utils/projectOptionLabel.js';
import { useProjectNodes } from '../../store/useProjectNodes.js';
import { BriefcaseBusiness, Columns3, List, Plus, RefreshCw, Search } from 'lucide-react';
import { useI18n } from '../../i18n/context.js';

export default function WorkBoardHeader({ onCreate, onProjectChange, onSourceChange, onQueryChange, onRefresh, onViewChange, projectId, projects, query, source, view }) {
  const nodesById = useProjectNodes();
  const { t } = useI18n();
  return (
    <header className="work-ledger-header">
      <div className="work-ledger-title">
        <div className="work-ledger-kicker font-mono">
          <BriefcaseBusiness size={14} />
          <span>02 WORK_LEDGER</span>
          <span className="text-zinc-500">[BOARD: ACTIVE_TASKS]</span>
        </div>
        <div className="work-ledger-heading-row">
          <h1>{t('work.board')}</h1>
        </div>
      </div>
      <div className="work-ledger-actions">
        <label className="work-header-search">
          <Search size={15} />
          <input
            aria-label={t('board.search')}
            onChange={event => onQueryChange(event.target.value)}
            placeholder={t('board.searchPlaceholder')}
            type="search"
            value={query}
          />
        </label>
        {projects.length > 1 ? (
          <select aria-label="按项目筛选" className="form-control work-header-project" onChange={event => onProjectChange(event.target.value)} value={projectId}>
            <option value="">全部项目</option>
            {projects.map(project => <option key={project.id} value={project.id}>{projectOptionLabel(project, nodesById, project.name || project.id)}</option>)}
          </select>
        ) : null}
        <label className="work-header-source">
          <span className="ds-mono-label">{t('board.source')}</span>
          <select aria-label={t('board.source')} className="form-control work-header-project" onChange={event => onSourceChange(event.target.value)} value={source}>
            <option value="">{t('board.sourceAll')}</option>
            <option value="github">GitHub</option>
            <option value="manual">{t('board.sourceManual')}</option>
          </select>
        </label>
        <div className="work-view-toggle" role="group" aria-label="视图">
          <button aria-label="列表视图" aria-pressed={view === 'list'} onClick={() => onViewChange('list')} title="列表" type="button"><List size={14} /></button>
          <button aria-label="看板视图" aria-pressed={view === 'board'} onClick={() => onViewChange('board')} title="看板" type="button"><Columns3 size={14} /></button>
        </div>
        <button aria-label={t('work.refresh')} className="work-action-secondary work-action-icon" onClick={onRefresh} title={t('work.refresh')} type="button">
          <RefreshCw size={14} />
        </button>
        <button className="work-action-primary" onClick={onCreate} type="button">
          <Plus size={16} /> {t('board.newWork')}
        </button>
      </div>
    </header>
  );
}
