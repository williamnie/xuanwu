import { useState } from 'react';
import { connectorsApi } from '../api/connectors.js';
export default function FeishuSourceDiscovery({ remote, dirty, onAuthorized }) {
  const [session, setSession] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const operate = async operation => {
    setBusy(true); setError('');
    try { await operation(); } catch (failure) { setError(failure.message || '来源发现失败'); } finally { setBusy(false); }
  };
  const authorize = (candidate, scope) => operate(async () => {
    const next = await connectorsApi.authorizeFeishuSource(session.id, { candidate_id: candidate.id, scope, expected_revision: remote.revision });
    onAuthorized(next); setSession(current => ({ ...current, consumed: true }));
  });
  return <div className="feishu-source-discovery">
    <h3>识别来源</h3><p>先保存应用配置，再在目标群或私聊发送挑战码。识别后由你选择允许的群或用户；已有其他限制仍生效。</p>
    {dirty && <p>配置有未保存的修改，请先保存后再发现或授权。</p>}
    {error && <p role="alert">{error}</p>}
    <button className="btn btn-secondary" type="button" disabled={busy || dirty || !remote?.enabled} onClick={() => operate(async () => setSession(await connectorsApi.startFeishuDiscovery()))}>开始来源发现</button>
    {session && <>
      <p>发送以下挑战码（群聊可 @ Bot）：</p><code>{session.challenge}</code>
      <p>有效至 {new Date(session.expires_at).toLocaleTimeString()}；仅保留这条消息的来源 ID。</p>
      <button className="btn btn-secondary" type="button" disabled={busy || session.consumed} onClick={() => operate(async () => setSession(await connectorsApi.getFeishuDiscovery(session.id)))}>检查来源</button>
      {!session.candidates?.length && <p>尚未收到匹配消息。检查应用订阅和接收连接后重试。</p>}
      {session.candidates?.map(candidate => <div className="feishu-discovery-candidate" key={candidate.id}>
        <p>群/会话：<code>{candidate.chat_id}</code><br/>用户：<code>{candidate.user_id}</code></p>
        <button className="btn btn-secondary" type="button" disabled={busy || dirty || session.consumed || !remote?.revision} onClick={() => authorize(candidate, 'chat')}>将此会话加入允许群</button>
        <button className="btn btn-secondary" type="button" disabled={busy || dirty || session.consumed || !remote?.revision} onClick={() => authorize(candidate, 'user')}>将此用户加入允许用户</button>
      </div>)}
      {session.consumed && <p role="status">来源已授权。需要授权另一个范围时，请重新开始发现。</p>}
    </>}
  </div>;
}
