import { create } from 'zustand';

export const useToastStore = create((set, get) => ({
  toasts: [],
  addToast: (content, type = 'info', duration = 4000) => {
    const id = Math.random().toString(36).substring(2, 9);
    set((state) => ({
      toasts: [...state.toasts, { id, content, type }],
    }));

    if (duration > 0) {
      setTimeout(() => {
        get().removeToast(id);
      }, duration);
    }
    return id;
  },
  removeToast: (id) => {
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    }));
  },
}));

// 提供极其便捷的命令式调用方式，可在任意非 React 组件上下文使用
export const message = {
  success: (content, duration) => useToastStore.getState().addToast(content, 'success', duration),
  error: (content, duration) => useToastStore.getState().addToast(content, 'error', duration),
  info: (content, duration) => useToastStore.getState().addToast(content, 'info', duration),
  warning: (content, duration) => useToastStore.getState().addToast(content, 'warning', duration),
};
