import { BRAND_STATES } from './brandState.js';
import { turtleAssetForState } from './brandAssets.js';
import './TurtleLoader.css';

export default function TurtleLoader({
  className = '',
  compact = false,
  label = '玄武正在整理工作区…',
}) {
  const classes = ['turtle-loader', compact ? 'compact' : '', className]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} role="status" aria-live="polite" aria-atomic="true">
      <div className="turtle-loader-track" aria-hidden="true">
        <span className="turtle-loader-runner">
          <img
            alt=""
            className="turtle-loader-image"
            draggable="false"
            src={turtleAssetForState(BRAND_STATES.running)}
          />
        </span>
      </div>
      <span className="turtle-loader-label">{label}</span>
    </div>
  );
}

export function PanelLoader({ className = '', label = '玄武正在读取数据…' }) {
  return (
    <div className={['panel-loading-state', className].filter(Boolean).join(' ')}>
      <TurtleLoader compact label={label} />
    </div>
  );
}
