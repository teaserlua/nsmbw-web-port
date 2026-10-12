// Loads the compressed game module. A SW update, interrupted download or
// streaming decoder can abort the first attempt; start a new request instead
// of leaving Play permanently stuck on a rejected promise.
'use strict';
const RGHModuleLoader = (() => {
  async function load({
    url = 'rgh.wasm.gz',
    attempts = 3,
    onRetry = () => {},
    fetchFile = (...args) => fetch(...args),
    wasm = WebAssembly,
    ResponseType = Response,
    Decompressor = DecompressionStream,
    delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}) {
    let error;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await fetchFile(url, { cache: attempt === 1 ? 'no-cache' : 'reload' });
        if (!response.ok) throw new Error(`Game module download returned HTTP ${response.status}`);
        if (!response.body) throw new Error('The game module response had no body');
        const decompressed = response.body.pipeThrough(new Decompressor('gzip'));
        if (attempt === attempts) {
          // If streaming compilation was cancelled, buffer the decompressed
          // module on the last attempt and compile it independently.
          const bytes = await new ResponseType(decompressed).arrayBuffer();
          return await wasm.compile(bytes);
        }
        return await wasm.compileStreaming(new ResponseType(decompressed, {
          headers: { 'Content-Type': 'application/wasm' },
        }));
      } catch (caught) {
        error = caught;
        if (attempt === attempts || /returned HTTP 4\d\d/.test(String(error?.message))) break;
        onRetry(attempt, error);
        await delay(attempt * 300);
      }
    }
    throw new Error(`Could not download or compile the game module after ${attempts} attempts: ${error?.message || error}`);
  }
  return { load };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = RGHModuleLoader;
