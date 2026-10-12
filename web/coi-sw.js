// GitHub Pages does not allow custom response headers. A same-origin service
// worker adds the isolation headers required for WebAssembly shared memory.
// Let an updated worker wait until existing tabs close. Forcing activation
// during a large streaming WASM download can abort the response mid-flight.
self.addEventListener('install', () => {});
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    // Always revalidate lightweight site files after a deployment. GitHub Pages
    // otherwise caches index.html, scripts and menu images for 10 minutes.
    // Keep the much larger WASM download cached between visits.
    const fresh = event.request.mode === 'navigate' ||
      /\.(?:html?|js|css|json|png|jpe?g|webp)$/i.test(url.pathname);
    const response = await fetch(event.request, fresh ? { cache: 'no-store' } : undefined);
    if (response.type !== 'basic' || [101, 204, 205, 304].includes(response.status)) return response;
    const headers = new Headers(response.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    if (fresh) headers.set('Cache-Control', 'no-store');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  })());
});
