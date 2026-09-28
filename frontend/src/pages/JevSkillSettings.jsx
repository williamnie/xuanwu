import { useCallback, useEffect, useReducer, useRef } from 'react';
import { LoaderCircle, RefreshCw, TestTube2 } from 'lucide-react';
import { jevSkillApi } from '../api/jevSkill.js';
import {
  initialJevState, JEV_SCOPES, jevAvailabilityLabel, jevDraftError,
  jevPayload, jevSettingsReducer,
} from './jevSkillSettingsModel.js';
import './JevSkillSettings.css';

export default function JevSkillSettings({ onStatus }) {
  const state = useJevSettings(onStatus);
  return (
    <section className="jev-settings" aria-label="Jev 技能配置">
      <div className="jev-settings__heading">
        <h4>Jev 配置</h4>
        <button className="btn btn-secondary" disabled={state.busy} onClick={() => state.reload()} type="button">
          <RefreshCw aria-hidden="true" size={14} className={state.loading ? 'spin-animation' : ''} /> 刷新状态
        </button>
      </div>
      <p className="jev-settings__hint">Jev 是可选辅助技能。仅在所选来源按需发送当前选择的报告片段；未启用、缺 Key 或服务故障时，玄武继续原有处理流程。</p>
      {state.error && <p className="jev-settings__error" role="alert">{state.error}</p>}
      {!state.remote ? (
        <p className="jev-settings__hint" role="status">{state.loading ? '正在读取 Jev 配置…' : '配置尚未加载，请刷新重试。'}</p>
      ) : (
        <>
          <Availability remote={state.remote} />
          <JevForm state={state} />
          <RecentCalls calls={state.remote.recent_calls || []} />
        </>
      )}
    </section>
  );
}

function useJevSettings(onStatus) {
  const [state, dispatch] = useReducer(jevSettingsReducer, undefined, initialJevState);
  const readSequence = useRef(0);
  const reload = useCallback(async (signal) => {
    const sequence = ++readSequence.current;
    dispatch({ type: 'load-start' });
    try {
      const settings = await jevSkillApi.get(signal ? { signal } : {});
      if (signal?.aborted || sequence !== readSequence.current) return;
      dispatch({ type: 'loaded', settings });
      onStatus?.(settings);
    } catch (error) {
      if (signal?.aborted || sequence !== readSequence.current) return;
      dispatch({ type: 'load-error', error: error.message || '读取 Jev 配置失败。' });
    }
  }, [onStatus]);
  useEffect(() => {
    const controller = new AbortController();
    reload(controller.signal);
    return () => { controller.abort(); readSequence.current += 1; };
  }, [reload]);

  async function save(event) {
    event.preventDefault();
    if (state.loading || state.saving || state.testing) return;
    const error = jevDraftError(state.draft);
    if (error) { dispatch({ type: 'save-error', error }); return; }
    dispatch({ type: 'save-start' });
    try {
      const settings = await jevSkillApi.save(jevPayload(state.draft));
      dispatch({ type: 'saved', settings, revisions: state.revisions });
      onStatus?.(settings);
    } catch (failure) {
      dispatch({ type: 'save-error', error: safeError(failure, state.draft.api_key, '保存 Jev 配置失败。') });
    }
  }

  async function testConnection() {
    if (state.loading || state.saving || state.testing) return;
    const error = jevDraftError(state.draft);
    if (error) { dispatch({ type: 'test-error', error }); return; }
    dispatch({ type: 'test-start' });
    try {
      const result = await jevSkillApi.test(jevPayload(state.draft));
      dispatch({ type: 'tested', result, revision: state.revision });
      await reload();
    } catch (failure) {
      dispatch({ type: 'test-error', error: safeError(failure, state.draft.api_key, '测试 Jev 连接失败。') });
    }
  }

  return {
    ...state, busy: state.loading || state.saving || state.testing,
    reload, save, testConnection, update: patch => dispatch({ type: 'edit', patch }),
  };
}

function Availability({ remote }) {
  const sourceLabel = { secret: '密钥服务', environment: '环境变量', file: '私有凭据文件', none: '未配置' };
  return (
    <div className="jev-settings__availability" aria-live="polite">
      <div className="jev-settings__facts">
        <div><small>Availability</small><strong data-status={remote.availability}>{jevAvailabilityLabel(remote.availability)}</strong></div>
        <div><small>Package</small><strong>{remote.installed ? '已安装' : '未安装'}</strong></div>
        <div><small>Credential</small><strong>{remote.api_key_configured ? '已配置' : '未配置'} · {sourceLabel[remote.credential_source] || remote.credential_source}</strong></div>
      </div>
      {!remote.installed && <p>技能包缺失，Jev 不会被调用。配置入口仍保留，恢复技能包后可继续使用。</p>}
      {remote.diagnostic && <p>{remote.diagnostic}</p>}
      {remote.cooldown_until && <p>冷却截止：{formatTime(remote.cooldown_until)}。冷却期间继续使用原有流程。</p>}
      {remote.migrated_from_github && <p>已读取旧 GitHub 配置；不会自动扩大到其他来源。保存后使用全局技能配置。</p>}
    </div>
  );
}

function JevForm({ state }) {
  const { draft, update } = state;
  return (
    <form className="jev-settings__form" onSubmit={state.save}>
      <label className="jev-settings__check">
        <input type="checkbox" checked={draft.enabled} onChange={event => update({ enabled: event.target.checked })} />
        <span>启用 Jev 辅助技能</span>
      </label>
      <div className="jev-settings__fields">
        <label className="jev-settings__field"><span>运行模式</span>
          <select className="form-control" value={draft.mode} onChange={event => update({ mode: event.target.value })}>
            <option value="shadow">shadow · 仅记录</option><option value="assist">assist · 提供辅助建议</option>
          </select>
        </label>
        <label className="jev-settings__field"><span>模型</span>
          <input className="form-control" required value={draft.model} onChange={event => update({ model: event.target.value })} spellCheck={false} />
        </label>
      </div>
      <p className="jev-settings__hint">shadow 只记录结果，不提供决策建议；assist 向 Agent 提供辅助结果，最终判断和权限门禁仍由玄武负责。</p>
      <fieldset className="jev-settings__scopes">
        <legend>允许使用的来源</legend>
        <div>{JEV_SCOPES.map(([value, label]) => (
          <label className="jev-settings__check" key={value}>
            <input type="checkbox" checked={draft.scopes.includes(value)} onChange={event => update({ scopes: event.target.checked ? [...draft.scopes, value] : draft.scopes.filter(scope => scope !== value) })} />
            <span>{label}</span>
          </label>
        ))}</div>
      </fieldset>
      {!draft.scopes.length && <p className="jev-settings__hint">未选择来源时，不会自动调用 Jev。</p>}
      <KeyField state={state} />
      <details className="jev-settings__advanced">
        <summary>高级设置</summary>
        <div className="jev-settings__fields">
          <label className="jev-settings__field"><span>最低置信度</span>
            <input className="form-control" type="number" min="0.5" max="1" step="0.01" required value={draft.min_confidence} onChange={event => update({ min_confidence: event.target.value })} />
          </label>
          <label className="jev-settings__field"><span>调用超时（毫秒）</span>
            <input className="form-control" type="number" min="500" max="30000" step="1" required value={draft.timeout_ms} onChange={event => update({ timeout_ms: event.target.value })} />
          </label>
        </div>
      </details>
      <div className="jev-settings__actions">
        <span className="jev-settings__hint">{Object.keys(state.dirty).length ? '有未保存的修改' : '当前配置已同步'}</span>
        <div>
          <button className="btn btn-secondary" disabled={state.busy || !state.remote.installed} aria-busy={state.testing} onClick={state.testConnection} type="button">
            {state.testing ? <LoaderCircle aria-hidden="true" size={14} className="spin-animation" /> : <TestTube2 aria-hidden="true" size={14} />} 测试连接
          </button>
          <button className="btn btn-primary" disabled={state.busy} aria-busy={state.saving} type="submit">
            {state.saving && <LoaderCircle aria-hidden="true" size={14} className="spin-animation" />} 保存配置
          </button>
        </div>
      </div>
      <p className="jev-settings__hint">连接测试使用当前草稿发送合成示例，不保存配置。通过测试不代表已启用或已验证所有任务。</p>
      {state.notice && <p className="jev-settings__notice" role="status">{state.notice}</p>}
      {state.testResult && <TestResult result={state.testResult} stale={state.testStale} />}
    </form>
  );
}

function KeyField({ state }) {
  return (
    <div className="jev-settings__key">
      <label className="jev-settings__field"><span>Jev API Key</span>
        <input className="form-control" type="password" autoComplete="new-password" spellCheck={false} value={state.draft.api_key} disabled={state.draft.clear_api_key} onChange={event => state.update({ api_key: event.target.value })} placeholder={state.remote.api_key_configured ? '已配置；留空保留当前凭据' : '填写新的 API Key'} />
      </label>
      <p className="jev-settings__hint">新 Key 写入密钥服务，保存后不回显。留空不会删除已有凭据。</p>
      <label className="jev-settings__check">
        <input type="checkbox" checked={state.draft.clear_api_key} onChange={event => state.update({ clear_api_key: event.target.checked })} />
        <span>移除当前凭据（保存后生效）</span>
      </label>
    </div>
  );
}

function TestResult({ result, stale }) {
  return (
    <div className={`jev-settings__test-result ${result.ok ? 'is-success' : 'is-warning'}`} role="status">
      <strong>{result.ok ? '连接测试通过' : '连接测试未通过'}</strong>
      <span>{result.status}{result.reason ? ` · ${result.reason}` : ''}</span>
      <small>{result.model || '—'} · {result.duration_ms ?? 0} ms</small>
      {stale && <p>此结果对应测试时的草稿；当前配置已修改，请重新测试。</p>}
    </div>
  );
}

function RecentCalls({ calls }) {
  return (
    <div className="jev-settings__history">
      <h4>最近调用与降级</h4>
      {!calls.length ? <p className="jev-settings__hint">暂无调用记录。</p> : (
        <ol>{calls.map((call, index) => (
          <li key={`${call.created_at}:${index}`}>
            <div><strong>{call.status}</strong><time>{formatTime(call.created_at)}</time></div>
            {call.reason && <p>{call.reason}</p>}
            <small>{call.source || 'unknown'} · {call.model || '—'} · {call.duration_ms ?? 0} ms</small>
          </li>
        ))}</ol>
      )}
    </div>
  );
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
}

function safeError(error, key, fallback) {
  const text = error.message || fallback;
  return key.trim() ? text.replaceAll(key.trim(), '[redacted]') : text;
}
