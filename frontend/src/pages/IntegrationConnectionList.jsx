import { useI18n } from '../i18n/context.js';
import { connectionHealth, receiverState } from './integrationConnections.js';

export default function IntegrationConnectionList({ channels, connectors, onConfigure }) {
  const { language } = useI18n();
  const english = language === 'en-US';
  const connections = [
    ['github', 'GitHub', english ? 'Repositories and issues' : '代码仓库与议题'],
    ['feishu', english ? 'Feishu' : '飞书', english ? 'Messages and notifications' : '消息与通知'],
    ['telegram', 'Telegram', english ? 'Messages and notifications' : '消息与通知'],
  ];
  return (
    <ul className="settings-connection-list" aria-label={english ? 'External connections' : '外部连接'}>
      {connections.map(([id, name, description]) => (
        <li className="settings-connection-row" key={id}>
          <div><strong>{name}</strong><p>{description}</p></div>
          <div className="settings-connection-states" aria-live="polite">
            {id === 'github' ? <>
              <ConnectionState label={english ? 'Event health' : '事件连接健康'} value={connectionHealth(connectors, 'github-events')} />
              <ConnectionState label={english ? 'Issue health' : '议题连接健康'} value={connectionHealth(connectors, 'github-issues')} />
            </> : <>
              <ConnectionState label={english ? 'Connection health' : '连接健康'} value={connectionHealth(connectors, id)} />
              <ConnectionState label={english ? 'Receiver' : '接收器运行'} value={receiverState(channels, id)} />
            </>}
          </div>
          <button className="btn btn-secondary" type="button" aria-label={`${name} ${english ? 'settings' : '设置'}`} onClick={() => onConfigure(id)}>{english ? 'Settings' : '设置'}</button>
        </li>
      ))}
    </ul>
  );
}

function ConnectionState({ label, value }) {
  const { language } = useI18n();
  return <span>{label}：<strong className={value === 'unknown' ? 'is-unknown' : ''}>{value === 'unknown' ? (language === 'en-US' ? 'Unknown' : '未知') : value}</strong></span>;
}
