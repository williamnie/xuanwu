export function installChunkLoadRecovery(runtime = globalThis) {
  runtime.addEventListener('vite:preloadError', (event) => {
    // 部署后，已打开的页面可能仍引用上一版的懒加载 chunk。
    // index.html 禁止缓存，因此刷新即可切换到当前构建的完整资源图。
    event.preventDefault();
    runtime.location.reload();
  });
}
