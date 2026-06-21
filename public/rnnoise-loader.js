// RNNoise loader - loads the WASM module and exposes it globally
(async function() {
  try {
    const { Rnnoise } = await import('./rnnoise.js');
    window.Rnnoise = Rnnoise;
    console.log('[rnnoise-loader] Rnnoise loaded successfully');
  } catch (e) {
    console.error('[rnnoise-loader] Failed to load Rnnoise:', e);
    window.Rnnoise = null;
  }
})();
