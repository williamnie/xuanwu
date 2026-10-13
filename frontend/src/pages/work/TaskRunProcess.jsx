import { RunContextBar } from "../Runs.jsx";
import SettingsDisclosure from "../../components/SettingsDisclosure.jsx";
import { canOperateTaskRun } from "./taskRunAuthority.js";
import { useEffect, useMemo, useRef, useState } from 'react';
import { runsApi } from '../../api/runs.js';
import { evidenceApi } from '../../api/evidence.js';
import SessionTranscript from '../sessions/SessionTranscript.jsx';
import { selectedRunAttempt } from '../runs/runDetailModel.js';
import { message } from '../../store/toastStore.js';

// 记录限定当前 Run/Attempt；执行操作只在确认归属且选中当前尝试时复用原 Run authority。
export default function TaskRunProcess({ runId, expectedWorkId, project, navigateTo }) {
  const [run, setRun] = useState(null);
  const [attemptId, setAttemptId] = useState('');
  const [state, setState] = useState({ messages: [], evidence: [], cursor: '', evidenceCursor: '', loading: true, error: '' });
  const requestVersion = useRef(0);
  const [runError, setRunError] = useState('');
  const attempt = useMemo(() => selectedRunAttempt(run, attemptId), [run, attemptId]);
  useEffect(() => {
    const controller = new AbortController();
    requestVersion.current += 1;
    setRun(null); setAttemptId("");
    setState({ messages: [], evidence: [], cursor: "", evidenceCursor: "", loading: true, error: "" });
    runsApi.getRun(runId, { signal: controller.signal }).then(result => { if (controller.signal.aborted) return; if (expectedWorkId && result.run?.work_id !== expectedWorkId) { setRunError('这次执行不属于当前任务');return; } setRun(result.run); setRunError(''); })
      .catch(error => { if (!controller.signal.aborted) setRunError(error.message || '读取执行失败'); });
    return () => controller.abort();
  }, [runId, expectedWorkId]);
  useEffect(() => {
    if (!attempt?.id) return;
    let active = true;
    requestVersion.current += 1;
    setState({ messages: [], evidence: [], cursor: '', evidenceCursor: '', loading: true, error: '' });
    Promise.allSettled([
      runsApi.getRunTranscript(runId, { attemptId: attempt.id, limit: 200 }),
      evidenceApi.listEvidence({ runId, limit: 100 }),
    ]).then(([transcript, evidence]) => {
      if (!active) return;
      const errors = [transcript, evidence].filter(result => result.status === 'rejected').map(result => result.reason?.message || '读取失败');
      setState({ messages: transcript.status === 'fulfilled' ? transcript.value.data || [] : [], cursor: transcript.status === 'fulfilled' ? transcript.value.nextCursor || '' : '', evidenceCursor: evidence.status === 'fulfilled' ? evidence.value.next_cursor || '' : '', evidence: evidence.status === 'fulfilled' ? (evidence.value.items || []).filter(item => item.attempt_id === attempt.id && item.run_id === runId) : [], loading: false, error: errors.join('；') });
    });
    return () => { active = false; };
  }, [attempt?.id, runId]);
  const loadOlder = async () => {
    const requestedAttempt = attempt?.id;
    const version = requestVersion.current;
    setState(current => ({ ...current, loading: true }));
    try {
      const page = await runsApi.getRunTranscript(runId, { attemptId: requestedAttempt, beforeId: state.cursor, limit: 200 });
      if (version !== requestVersion.current) return;
      setState(current => ({ ...current, messages: [...(page.data || []), ...current.messages], cursor: page.nextCursor || '', loading: false }));
    } catch (error) { message.error(error.message); setState(current => ({ ...current, loading: false })); }
  };
  const loadEarlierEvidence = async () => {
    const version = requestVersion.current;
    const requestedAttempt = attempt?.id;
    try {
      const page = await evidenceApi.listEvidence({ runId, cursor: state.evidenceCursor, limit: 100 });
      if (version !== requestVersion.current) return;
      setState(current => ({ ...current, evidence: [...current.evidence, ...(page.items || []).filter(item => item.attempt_id === requestedAttempt && item.run_id === runId)], evidenceCursor: page.next_cursor || '' }));
    } catch (error) { message.error(error.message); }
  };
  const session = { id: `${runId}:${attempt?.id || ''}`, provider: attempt?.provider_ref?.provider || run?.provider || '', created_at: attempt?.started_at, updated_at: attempt?.ended_at, turns: [{ id: attempt?.id, status: attempt?.status, items: state.messages }] };
  return <div className="task-run-process">
    {runError && <p role="alert">{runError}</p>}
    {canOperateTaskRun(run, expectedWorkId, runId, attempt) && <SettingsDisclosure title="执行操作"><RunContextBar run={run} navigateTo={navigateTo} onRunChanged={nextRun => {
      if (nextRun?.work_id !== expectedWorkId) { setRunError("执行归属已变化，请重新核对"); return; }
      if (nextRun.id !== runId) navigateTo("work", expectedWorkId, "", "", { runId: nextRun.id });
      else setRun(nextRun);
    }}/></SettingsDisclosure>}
    {run?.attempts?.length > 1 && <label>尝试<select className="form-control" aria-label="选择尝试" value={attempt?.id || ''} onChange={event => setAttemptId(event.target.value)}>{run.attempts.map(item => <option key={item.id} value={item.id}>第 {item.sequence} 次尝试 · {item.status}</option>)}</select></label>}
    {state.error && <p role="alert">部分记录暂不可用：{state.error}</p>}
    {state.loading && !state.messages.length && <p role="status">正在读取此尝试的记录…</p>}
    {!state.loading && !state.messages.length && <p>此尝试尚无已保存的执行记录。</p>}
    <p>以下为此执行和尝试已保存的回复记录。</p>
    {state.messages.length > 0 && <SessionTranscript session={session} project={project} navigateTo={navigateTo} liveEvents={[]} optimisticUserMessages={[]} running={false} sending={false} readOnly hasOlderTurns={Boolean(state.cursor)} loadOlderTurns={loadOlder} turnsLoading={state.loading} />}
    {state.evidenceCursor && <button className="btn btn-secondary" onClick={loadEarlierEvidence} type="button">更早验证结果</button>}
    <div className="task-run-evidence">{state.evidence.map(item => <p key={item.id}>验证结果：{item.status} · {item.kind} · {item.created_at}{item.freshness?.is_stale ? ' · 已过期' : ''}</p>)}</div>
  </div>;
}
