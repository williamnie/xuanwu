import { useToastStore } from '../store/toastStore';
import { CheckCircle2, AlertCircle, AlertTriangle, Info, X } from 'lucide-react';
import './ToastContainer.css';

export default function ToastContainer() {
  const toasts = useToastStore((state) => state.toasts);
  const removeToast = useToastStore((state) => state.removeToast);

  if (toasts.length === 0) return null;

  return (
    <div className="codex-toast-container">
      {toasts.map((toast) => {
        let Icon;

        switch (toast.type) {
          case 'success':
            Icon = CheckCircle2;
            break;
          case 'error':
            Icon = AlertCircle;
            break;
          case 'warning':
            Icon = AlertTriangle;
            break;
          case 'info':
          default:
            Icon = Info;
            break;
        }

        return (
          <div 
            key={toast.id} 
            className={`codex-toast-item ${toast.type}`}
            onClick={() => removeToast(toast.id)}
          >
            <span className={`codex-toast-icon is-${toast.type || 'info'}`}>
              <Icon size={16} strokeWidth={2.4} />
            </span>
            <span className="codex-toast-content">{toast.content}</span>
            <button className="codex-toast-close" onClick={(e) => {
              e.stopPropagation();
              removeToast(toast.id);
            }}>
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
