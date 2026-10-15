import { useI18n } from '../../i18n/context.js';
import { scheduleBlockers, scheduleReasonText, scheduleWorkHref } from './workScheduleModel.js';
import './WorkSchedule.css';

export function ScheduleBlockerLinks({ reason }) {
  const blockers = scheduleBlockers(reason);
  if (!blockers.length) return null;
  return <span className="work-schedule-links">{blockers.map(blocker => (
    <a href={scheduleWorkHref(blocker.work_id)} key={blocker.work_id} onClick={event => event.stopPropagation()}>
      {blocker.title || blocker.work_id}
    </a>
  ))}</span>;
}

export default function WorkSchedule({ work, all = false }) {
  const { t } = useI18n();
  if (work?.status !== 'todo' || !work.schedule) return null;
  const reasons = work.schedule.reasons || [];
  return <div className="work-schedule" aria-label={t('schedule.label')}>
    {all ? <span className="ds-mono-label">SCHEDULE</span> : null}
    {reasons.length ? (all ? reasons : reasons.slice(0, 1)).map(reason => (
      <div className="work-schedule-reason" key={reason.code}>
        <span>{scheduleReasonText(reason, t)}</span>
        <ScheduleBlockerLinks reason={reason} />
      </div>
    )) : <span>{t('schedule.runnable')}</span>}
  </div>;
}
