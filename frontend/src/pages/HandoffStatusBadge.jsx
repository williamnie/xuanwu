import { deliveryTone } from './handoffPageModel.js';
export function StatusBadge({ status }) {
  return <span className="handoff-status" data-tone={deliveryTone(status)}>{status || 'unknown'}</span>;
}

