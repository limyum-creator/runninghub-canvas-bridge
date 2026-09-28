// Modified 2026-09-27: international site validation.
(() => {
  if (!globalThis.RHCanvasSitePolicy?.parseCanvas(location.href)) return;
  const BRIDGE = "http://127.0.0.1:18765";
  const LOADER_KEY = "__RUNNINGHUB_CANVAS_BRIDGE_LOADER__";
  const LOADER_VERSION = "0.5.0";
  const PROTOCOL_VERSION = "1";

  if (window[LOADER_KEY]?.loading) return;
  window[LOADER_KEY] = { loading: true, loadedAt: 0, error: null };
  window.__RUNNINGHUB_CANVAS_BRIDGE_LOADER_VERSION__ = LOADER_VERSION;
  window.__RUNNINGHUB_CANVAS_BRIDGE_PROTOCOL_VERSION__ = PROTOCOL_VERSION;

  const loadRuntime = async () => {
    const url = `${BRIDGE}/bridge-runtime.js?ts=${Date.now()}`;
    const response = await fetch(url, { mode: "cors", cache: "no-store" });
    if (!response.ok) throw new Error(`Failed to load bridge runtime: ${response.status}`);
    const code = await response.text();
    new Function(`${code}\n//# sourceURL=runninghub-canvas-bridge-runtime.js`)();
    window[LOADER_KEY] = { loading: false, loadedAt: Date.now(), error: null };
  };

  loadRuntime().catch((error) => {
    window[LOADER_KEY] = {
      loading: false,
      loadedAt: 0,
      error: error && error.stack ? error.stack : String(error)
    };
    console.warn("[RunningHub Canvas Bridge] runtime load failed", error);
  });
})();
