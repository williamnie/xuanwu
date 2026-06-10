import { SERVICE_TIER_FAST, SERVICE_TIER_STANDARD, normalizeServiceTier } from './serviceTier.js';

const NORMAL_LABEL = '正常';
const FAST_LABEL = '快速';

export function isFastIssueSpeed(serviceTier) {
  return normalizeServiceTier(serviceTier) === SERVICE_TIER_FAST;
}

export function issueSpeedToggleCopy(serviceTier) {
  const enabled = isFastIssueSpeed(serviceTier);
  const currentLabel = enabled ? FAST_LABEL : NORMAL_LABEL;
  const nextLabel = enabled ? NORMAL_LABEL : FAST_LABEL;
  const nextServiceTier = enabled ? SERVICE_TIER_STANDARD : SERVICE_TIER_FAST;
  return {
    enabled,
    currentLabel,
    nextLabel,
    nextServiceTier,
    ariaLabel: `执行速度：当前${currentLabel}；点击切换为${nextLabel}`,
    title: `闪电${enabled ? '已点亮，快速模式开启' : '未点亮，正常速度'}；点击切换为${nextLabel}速度`,
  };
}
