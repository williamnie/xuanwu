import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, Inbox, LoaderCircle } from 'lucide-react';
import { eventsApi } from '../../api/events.js';
import { workApi } from '../../api/work.js';
import { message } from '../../store/toastStore.js';
import { useI18n } from '../../i18n/context.js';
import { workBlockReason } from '../workDetailModel.js';
import { issueIdFromWorkId } from '../workBoardModel.js';
import { TASK_SCOPES, scopeCount } from './taskListModel.js';
import { executeWorkMove, workRowActions } from './workActions.js';
import './TaskList.css';


const PAGE_SIZE = 30;
const LIST_REFRESH_EVENT_TYPES = new Set(['issue.created', 'issue.deleted', 'issue.status_changed', 'issue.updated']);

// 任务页默认视图：服务端筛选与分页；行内按钮与看板拖拽共用 workActions 的动作表。
export default function TaskList({ counts = {}, navigateTo, onCreate, onEdit, projectId, projects, query, source = '', refreshToken = 0, scope, onScopeChange }) {
  const { language, t } = useI18n();
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(null);
  const [nextCursor, setNextCursor] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [confirming, setConfirming] = useState(null);
  const [expandedId, setExpandedId] = useState('');
  const requestVersion = useRef(0);
  const statuses = TASK_SCOPES.find(item => item.id === scope)?.statuses || [];
  const statusKey = statuses.join(',');

  const load = useCallback(async ({ silent = false } = {}) => {
    const version = ++requestVersion.current;
    if (!silent) setLoading(true);
    try {
      const response = await workApi.getWorks({
        pageSize: PAGE_SIZE,
        projectId,
        source,
        query: query.trim(),
        statuses: statusKey ? statusKey.split(',') : [],
      });
      if (version !== requestVersion.current) return;
      setItems(response?.items || []);
      setTotal(response?.total ?? null);
      setNextCursor(response?.next_cursor || '');
      setHasMore(Boolean(response?.has_more));
      setError('');
    } catch (loadError) {
      if (version === requestVersion.current) setError(loadError.message || t('board.loadFailed'));
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [projectId, query, source, statusKey, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, query ? 250 : 0);
    return () => {
      window.clearTimeout(timer);
      requestVersion.current += 1;
    };
  }, [load, query, refreshToken]);

  useEffect(() => {
    let timer = 0;
    const unsubscribe = eventsApi.subscribeToEvents(event => {
      if (timer || !LIST_REFRESH_EVENT_TYPES.has(event?.type)) return;
      timer = window.setTimeout(() => {
        timer = 0;
        // 已经翻页时不整体替换，避免用户正在看的位置跳动。
        if (!nextCursor || items.length <= PAGE_SIZE) void load({ silent: true });
      }, 500);
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [items.length, load, nextCursor]);

  const loadMore = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    const version = requestVersion.current;
    try {
      const response = await workApi.getWorks({
        cursor: nextCursor,
        page: nextCursor ? 1 : Math.floor(items.length / PAGE_SIZE) + 1,
        pageSize: PAGE_SIZE,
        projectId,
        source,
        query: query.trim(),
        statuses,
      });
      if (version !== requestVersion.current) return;
      setItems(current => mergeById(current, response?.items || []));
      setNextCursor(response?.next_cursor || '');
      setHasMore(Boolean(response?.has_more));
    } catch (loadError) {
      message.error(loadError.message || t('board.loadMoreFailed'));
    } finally {
      setLoadingMore(false);
    }
  };

  const perform = async (work, action) => {
    setBusyId(work.id);
    try {
      const result = await executeWorkMove(work, action.target);
      message.success(result.operation === 'cancel' ? t('work.cancelled') : result.operation === 'retry' ? t('work.requeued') : result.operation === 'enqueue' ? t('work.enqueued') : '任务已更新');
      setConfirming(null);
      setExpandedId('');
      await load({ silent: true });
    } catch (actionError) {
      message.error(actionError.message || t('work.actionFailed'));
      if (actionError.status === 409) await load({ silent: true });
    } finally {
      setBusyId('');
    }
  };

  const request = (work, action) => {
    if (action.confirm) setConfirming({ action, work });
    else void perform(work, action);
  };

  const projectById = new Map(projects.map(project => [project.id, project]));

  return (
    <section className="task-list">
      <div className="task-list-filters">
        <div className="task-list-scopes" role="group" aria-label="任务筛选">
          {TASK_SCOPES.map(item => (
            <button aria-pressed={scope === item.id} key={item.id} onClick={() => onScopeChange(item.id)} type="button">
              {item.label}
              <span>{source ? (item.id === scope ? total ?? '' : '') : scopeCount(item, counts)}</span>
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div className="task-list-state is-error" role="alert">
          <AlertTriangle size={16} />
          <span>{error}</span>
          <button className="btn btn-secondary" onClick={() => load()} type="button">{t('chat.retry')}</button>
        </div>
      ) : null}

      {loading && items.length === 0 && !error ? (
        <div className="task-list-state"><LoaderCircle className="is-spinning" size={14} /> 正在读取任务…</div>
      ) : null}

      {!loading && !error && items.length === 0 ? (
        <div className="task-list-empty">
          <Inbox size={34} />
          <p>{query || projectId || source ? '没有符合条件的任务' : scope === 'attention' ? '没有需要你处理的任务' : '这里还没有任务'}</p>
          <button className="btn btn-secondary" onClick={onCreate} type="button">新建任务</button>
        </div>
      ) : null}

      {items.length > 0 ? (
        <ul className="task-list-rows" aria-busy={loading}>
          {items.map(work => {
            const project = projectById.get(work.owner?.project_id);
            const actions = workRowActions(work.status);
            const primary = actions.find(action => action.primary);
            const secondary = actions.filter(action => action !== primary);
            const issueId = issueIdFromWorkId(work.id);
            const detail = workBlockReason(work, project) || firstLine(work.goal);
            const expanded = expandedId === work.id;
            const canEdit = work.status !== 'in_progress';
            return (
              <li className={`task-list-row${expanded ? ' is-expanded' : ''}`} key={work.id}>
                <button className="task-list-main" onClick={() => navigateTo('work', work.id)} type="button">
                  <span className="task-list-dot" data-status={work.status} />
                  <span className="task-list-text">
                    <strong>{work.title}</strong>
                    <small>{detail}</small>
                  </span>
                  <span className="task-list-meta">
                    <em data-status={work.status}>{t(`status.${work.status}`)}</em>
                    <span>{project?.name || work.owner?.project_id || '—'}{issueId ? ` · #${issueId}` : ''}</span>
                    <time dateTime={work.updated_at}>{relativeTime(work.updated_at, language)}</time>
                  </span>
                </button>
                <div className="task-list-actions">
                  {work.status === 'needs_user' ? (
                    <button className="btn btn-secondary btn-sm" onClick={() => navigateTo('work', work.id)} type="button">去处理</button>
                  ) : primary ? (
                    <button className="btn btn-secondary btn-sm" disabled={Boolean(busyId)} onClick={() => request(work, primary)} type="button">{primary.label}</button>
                  ) : null}
                  {secondary.length > 0 || canEdit ? (
                    <button
                      aria-expanded={expanded}
                      aria-label={`更多操作：${work.title}`}
                      className="task-list-more"
                      onClick={() => setExpandedId(expanded ? '' : work.id)}
                      type="button"
                    >
                      更多 <ChevronDown size={13} />
                    </button>
                  ) : null}
                </div>
                {expanded ? (
                  <div className="task-list-secondary">
                    {canEdit ? <button className="btn btn-secondary btn-sm" onClick={() => { setExpandedId(''); onEdit(work); }} type="button">{t('work.edit')}</button> : null}
                    {secondary.map(action => (
                      <button className={`btn btn-secondary btn-sm${action.danger ? ' is-danger' : ''}`} disabled={Boolean(busyId)} key={action.id} onClick={() => request(work, action)} type="button">{action.label}</button>
                    ))}
                  </div>
                ) : null}
                {confirming?.work.id === work.id ? (
                  <div className="task-list-confirm" role="alertdialog" aria-label={`确认${confirming.action.label}`}>
                    <AlertTriangle size={14} />
                    <span>确认{confirming.action.label}“{work.title}”？{work.status === 'in_progress' ? '当前执行会被中断。' : ''}操作会写入审计记录。</span>
                    <button className="btn btn-secondary btn-sm" disabled={busyId === work.id} onClick={() => setConfirming(null)} type="button">返回</button>
                    <button className={`btn btn-secondary btn-sm${confirming.action.danger ? ' is-danger' : ''}`} disabled={busyId === work.id} onClick={() => perform(work, confirming.action)} type="button">{busyId === work.id ? '提交中…' : '确认'}</button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {hasMore ? (
        <button className="task-list-load-more" disabled={loadingMore} onClick={loadMore} type="button">
          {loadingMore ? '加载中…' : '加载更多'}
        </button>
      ) : null}
    </section>
  );
}


function mergeById(current, incoming) {
  const byId = new Map(current.map(item => [item.id, item]));
  incoming.forEach(item => byId.set(item.id, item));
  return [...byId.values()];
}

function firstLine(value) {
  return String(value || '').split('\n').map(line => line.trim()).find(Boolean) || '';
}

function relativeTime(value, language) {
  const time = Date.parse(value || '');
  if (!Number.isFinite(time)) return '';
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return language === 'en-US' ? 'just now' : '刚刚';
  if (minutes < 60) return language === 'en-US' ? `${minutes}m ago` : `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return language === 'en-US' ? `${hours}h ago` : `${hours} 小时前`;
  return new Date(time).toLocaleDateString(language);
}
