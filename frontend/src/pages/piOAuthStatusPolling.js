export function watchPiOAuthStatus({ readStatus, onStatus, intervalMs = 1500, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let stopped = false;
  let timer;
  const poll = async () => {
    try {
      const status = await readStatus();
      if (stopped) return;
      onStatus(status);
      if ((status?.status || status?.pi_oauth?.status) !== 'pending') return;
    } catch {
      // 短暂断网不等于授权失败；下一次读取后端的权威状态。
    }
    if (!stopped) timer = setTimer(poll, intervalMs);
  };
  timer = setTimer(poll, intervalMs);
  return () => { stopped = true; clearTimer(timer); };
}
