import { lazy, Suspense, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { firstDeliveryApi } from '../../api/firstDelivery.js';
import { assistantApi } from '../../api/assistant.js';
import { openDeliveryReview } from './onboardingDeliveryReview.js';

const PiChat = lazy(() => import('../PiChat.jsx'));
const stayInOnboarding = () => {};

export default function OnboardingDeliveryReview({ onRefresh, work }) {
  const [conversationID, setConversationID] = useState('');
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const opening = useRef(false);

  const check = async () => {
    if (opening.current) return;
    opening.current = true;
    setChecking(true);
    setError('');
    try { await firstDeliveryApi.completeDelivery(work.id); await onRefresh(); }
    catch (failure) { setError(failure.message || '交付检查失败，请补齐验证后重试'); }
    finally { opening.current = false; setChecking(false); }
  };
  const open = async () => {
    if (opening.current) return;
    opening.current = true;
    setBusy(true);
    setError('');
    try {
      await openDeliveryReview(work, assistantApi, setConversationID);
      await onRefresh();
    } catch (failure) {
      setError(`${failure.message || '检查暂不可用'}。已有会话会保留，请在下方继续或重新打开。`);
    } finally {
      opening.current = false;
      setBusy(false);
    }
  };

  return (
    <section className="onboarding-delivery-review" aria-label="首次交付检查">
      <p>玄武会检查这次执行并整理交付结果；需要你回复或确认时，可以直接在这里继续。</p>
      <button className="btn btn-primary" disabled={checking || busy || work.status !== 'done'} onClick={check} type="button">
        {checking ? <Loader2 className="spin-animation" size={14} /> : null} 完成交付检查
      </button>
      {!conversationID ? <button className="btn btn-secondary" disabled={busy || checking} onClick={open} type="button">
        {busy ? <Loader2 className="spin-animation" size={14} /> : null} 让玄武协助
      </button> : null}
      {error ? <p role="alert">{error}</p> : null}
      {conversationID ? <Suspense fallback={<p role="status">正在打开交付检查…</p>}>
        <PiChat embedded initialConversationId={conversationID} navigateTo={stayInOnboarding} />
      </Suspense> : null}
    </section>
  );
}
