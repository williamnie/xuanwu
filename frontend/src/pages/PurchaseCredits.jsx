import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, CheckCircle2, CreditCard, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { api } from '../api/client';
import { message } from '../store/toastStore';
import './PurchaseCredits.css';

const DEFAULT_CREDIT_PACKS = [
  { credits: 500, external_product_id: 'credit-500', unit_amount: 4000 },
  { credits: 1000, external_product_id: 'credit-1000', unit_amount: 7900 },
  { credits: 2200, external_product_id: 'credit-2200', unit_amount: 14900, bonusCredits: 200 },
];

const SUCCESS_PATH = '/payment/success';
const PURCHASE_PLACEHOLDER_HASH = '#purchase-credits';
const PENDING_PURCHASE_ATTEMPT_STORAGE_KEY = 'pending_purchase_attempt_id';

export default function PurchaseCredits({ navigateTo }) {
  const controller = usePurchaseCreditsController();
  return (
    <div className="purchase-credits-page animate-fade-in">
      <header className="purchase-credits-header">
        <button className="purchase-credits-back" onClick={() => navigateTo('pi-chat')} type="button">
          <ArrowLeft size={16} />
          Back
        </button>
        <div className="purchase-credits-title-block">
          <span>Personal · More Credits</span>
          <h1>Buy More Credits</h1>
          <p>Reserve one-time credit packs now. Apple Pay checkout will plug into this page when the API is ready.</p>
        </div>
        <button className="purchase-credits-refresh" disabled={controller.loading} onClick={controller.reload} type="button">
          <RefreshCw className={controller.loading ? 'spin-animation' : ''} size={16} />
          Refresh
        </button>
      </header>

      <section className="purchase-credits-shell">
        <PurchaseHero />
        <PurchaseCreditBody {...controller} />
      </section>
    </div>
  );
}

function usePurchaseCreditsController() {
  const [state, setState] = useState(() => ({ catalog: null, error: '', loading: true, purchasingId: '' }));
  const loadCatalog = useCallback(async () => {
    setState((current) => ({ ...current, error: '', loading: true }));
    try {
      const catalog = normalizePaymentCatalog(await api.getPaymentCatalog());
      setState((current) => ({ ...current, catalog, error: '', loading: false }));
    } catch {
      setState((current) => ({ ...current, catalog: null, error: '', loading: false }));
    }
  }, []);

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  const packs = useMemo(() => buildCreditPacks(state.catalog), [state.catalog]);
  const buyPack = useCreditPackPurchase(setState);
  return { ...state, packs, onBuyPack: buyPack, reload: loadCatalog };
}

function useCreditPackPurchase(setState) {
  return useCallback(async (pack) => {
    if (!pack.can_purchase) return;
    setState((current) => ({ ...current, purchasingId: pack.id }));
    try {
      const purchase = await api.createPaymentPurchase(paymentPurchasePayload(pack));
      const result = purchase?.result || {};
      if (result.purchase_attempt_id) savePendingPurchaseAttemptId(result.purchase_attempt_id);
      if (!result.checkout_url) {
        message.info('付款接口已预留，Apple Pay 接口就绪后将在这里继续支付。');
        navigateToPurchasePlaceholder();
        return;
      }
      window.location.assign(result.checkout_url);
    } catch (err) {
      message.error(err.message || '创建购买订单失败');
    } finally {
      setState((current) => ({ ...current, purchasingId: '' }));
    }
  }, [setState]);
}

function PurchaseHero() {
  return (
    <div className="purchase-credits-hero">
      <span className="purchase-credits-hero-icon"><Sparkles size={18} /></span>
      <div>
        <strong>Keep generations moving</strong>
        <p>Credits are added to the one-time bucket and are ready for future Apple Pay purchase flow.</p>
      </div>
    </div>
  );
}

function PurchaseCreditBody({ error, loading, onBuyPack, packs, purchasingId, reload }) {
  if (loading) return <PurchaseCreditsState icon={<Loader2 className="spin-animation" size={22} />} text="Loading credit packs..." />;
  if (error) {
    return (
      <PurchaseCreditsState text={error}>
        <button className="purchase-credits-state-action" onClick={reload} type="button">Try again</button>
      </PurchaseCreditsState>
    );
  }
  return (
    <div className="purchase-credit-grid" role="list">
      {packs.map((pack) => (
        <CreditPackCard
          key={pack.id}
          onBuy={onBuyPack}
          pack={pack}
          purchasing={purchasingId === pack.id}
        />
      ))}
    </div>
  );
}

function CreditPackCard({ onBuy, pack, purchasing }) {
  const disabled = purchasing || !pack.can_purchase;
  return (
    <article className="purchase-credit-card" data-product-id={pack.external_product_id} role="listitem">
      <div className="purchase-credit-card-topline">
        <span className="purchase-credit-card-icon"><CreditCard size={16} /></span>
        {pack.channel === 'apple' ? <span className="purchase-credit-channel">Apple Pay</span> : null}
      </div>
      <div className="purchase-credit-amount">
        <strong>{formatNumber(pack.credits)}</strong>
        <span>credits</span>
      </div>
      {pack.bonusCredits ? <p className="purchase-credit-bonus">Includes +{formatNumber(pack.bonusCredits)} bonus credits</p> : null}
      <div className="purchase-credit-footer">
        <span className="purchase-credit-price">{formatMoney(pack.unit_amount, pack.currency)}</span>
        <button className="purchase-credit-buy" disabled={disabled} onClick={() => onBuy(pack)} type="button">
          {purchasing ? <Loader2 className="spin-animation" size={14} /> : buttonIcon(pack)}
          {pack.can_purchase ? 'Buy' : 'Coming soon'}
        </button>
      </div>
    </article>
  );
}

function PurchaseCreditsState({ children, icon = null, text }) {
  return (
    <div className="purchase-credits-state">
      {icon}
      <span>{text}</span>
      {children}
    </div>
  );
}

function normalizePaymentCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object' || !Array.isArray(catalog.items)) return { items: [] };
  return { items: catalog.items.map(normalizeCatalogItem).filter(Boolean) };
}

function normalizeCatalogItem(item) {
  if (!item || typeof item !== 'object') return null;
  const id = String(item.external_product_id || '').trim();
  if (!id) return null;
  const grants = Array.isArray(item.bucket_grants) ? item.bucket_grants : [];
  return {
    allowed: item.allowed !== false,
    billing_cycle: String(item.billing_cycle || ''),
    bucket_grants: grants.map(normalizeBucketGrant).filter(Boolean),
    can_purchase: item.can_purchase !== false,
    channel: item.channel === 'apple' ? 'apple' : 'stripe',
    currency: String(item.currency || 'USD'),
    external_product_id: id,
    mode: String(item.mode || 'payment'),
    unit_amount: finiteNumber(item.unit_amount, 0),
  };
}

function normalizeBucketGrant(grant) {
  if (!grant || typeof grant !== 'object') return null;
  return { amount: finiteNumber(grant.amount, 0), bucket: String(grant.bucket || '') };
}

function buildCreditPacks(catalog) {
  const packs = (catalog?.items || [])
    .filter((item) => item.billing_cycle === 'one_time')
    .map(paymentItemToCreditPack)
    .filter((pack) => pack.credits > 0)
    .sort((left, right) => left.credits - right.credits || left.unit_amount - right.unit_amount);
  return packs.length > 0 ? packs : DEFAULT_CREDIT_PACKS.map(defaultPackToCreditPack);
}

function paymentItemToCreditPack(item) {
  const credits = creditAmount(item.bucket_grants, 'one_time');
  return {
    can_purchase: item.allowed && item.can_purchase,
    channel: item.channel,
    credits,
    currency: item.currency,
    external_product_id: item.external_product_id,
    id: item.external_product_id,
    unit_amount: item.unit_amount,
  };
}

function defaultPackToCreditPack(pack) {
  return {
    can_purchase: false,
    channel: 'apple',
    currency: 'USD',
    id: pack.external_product_id,
    ...pack,
  };
}

function buttonIcon(pack) {
  return pack.can_purchase ? <CheckCircle2 size={14} /> : null;
}

function paymentPurchasePayload(pack) {
  const origin = window.location.origin;
  return {
    cancel_url: `${origin}/${PURCHASE_PLACEHOLDER_HASH}`,
    channel: pack.channel,
    external_product_id: pack.external_product_id,
    success_url: `${origin}${SUCCESS_PATH}`,
  };
}

function navigateToPurchasePlaceholder() {
  window.history.pushState(null, '', PURCHASE_PLACEHOLDER_HASH);
}

function savePendingPurchaseAttemptId(purchaseAttemptId) {
  try {
    sessionStorage.setItem(PENDING_PURCHASE_ATTEMPT_STORAGE_KEY, purchaseAttemptId);
  } catch {
    // 忽略隐私模式或存储不可用；后续状态页仍可从 URL 读取。
  }
}

function creditAmount(grants, bucket) {
  return grants.reduce((total, grant) => (grant.bucket === bucket ? total + grant.amount : total), 0);
}

function finiteNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function formatMoney(amountInMinorUnit, currency) {
  return new Intl.NumberFormat('en-US', { currency, style: 'currency' }).format(amountInMinorUnit / 100);
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(value);
}
