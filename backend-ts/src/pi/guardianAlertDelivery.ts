import type { PiGuardianAlert } from "../db/repositories/pi.ts";

export type GuardianAlertDelivery = {
  connectorID: string;
  send(alert: PiGuardianAlert, options?: {
    formatText?: (alert: PiGuardianAlert) => string;
    now?: Date;
  }): Promise<void>;
};
