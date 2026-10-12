// Register before the game runtime starts. The worker controls the second load.
if ((location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname)) &&
    'serviceWorker' in navigator) {
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!reloading && !crossOriginIsolated) { reloading = true; location.reload(); }
  });
  navigator.serviceWorker.register('./coi-sw.js', { scope: './', updateViaCache: 'none' })
    // Registration already checks for updates. Calling update() again at page
    // startup can replace the active worker while WebAssembly is streaming.
    .catch((err) => { console.error('Cannot enable cross-origin isolation:', err); });
}
