import { randomUUID } from "node:crypto";
import "../extension/site-policy.js";
const policy=globalThis.RHCanvasSitePolicy;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export class BridgeClient {
  constructor(base = process.env.RH_BRIDGE_URL || "http://127.0.0.1:18765") {
    const url = new URL(base);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.username || url.password) {
      throw new Error("Bridge must be a loopback HTTP service");
    }
    this.base = url.origin;
    this.canvasUrl = null;
  }
  async request(path, body, timeoutMs = 8000) {
    const response = await fetch(this.base + path, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.errorCode || value.error || `HTTP ${response.status}`);
    return value;
  }
  async status() {
    const [health, clients] = await Promise.all([this.request("/health"), this.request("/clients")]);
    return { ...health, selectedCanvas: this.canvasUrl, clients: clients.map(c => ({ clientId: c.clientId, canvasUrl: c.href, title: c.title, runtimeFreshness: c.runtimeFreshness })) };
  }
  async select(canvasUrl, allowWrites) {
    const canvas = policy.parseCanvas(canvasUrl);
    if (!canvas) throw new Error("INVALID_CANVAS_URL");
    for(let attempt=0;attempt<15;attempt++) {
      const clients=await this.request('/clients');
      if(clients.some(c=>policy.parseCanvas(c.href)?.key===canvas.key))break;
      if(attempt===14)throw new Error('CANVAS_NOT_CONNECTED');
      await pause(400);
    }
    const result = await this.request("/access", { canvasUrl, allowWrites });
    this.canvasUrl = new URL(canvasUrl).origin + new URL(canvasUrl).pathname;
    await this.target();
    return { ...result, canvasUrl: this.canvasUrl };
  }
  async target() {
    if (!this.canvasUrl) throw new Error("SELECT_CANVAS_FIRST: call rh_select_canvas with an observed connected URL");
    const expected = policy.parseCanvas(this.canvasUrl);
    for (let attempt = 0; attempt < 15; attempt++) {
      const clients = await this.request("/clients");
      const match = clients.find(c => policy.parseCanvas(c.href)?.key === expected.key && c.runtimeFreshness === "fresh");
      if (match) return { clientId: match.clientId, canvasId: expected.canvasId, canvasOrigin: expected.origin };
      await pause(400);
    }
    throw new Error("CANVAS_NOT_CONNECTED: open or refresh the selected canvas in Chrome");
  }
  async command(type, args = {}, { id = randomUUID(), timeoutMs = 45000 } = {}) {
    const target = await this.target();
    const command = { ...args, ...target, type, id, compactMutation: true };
    // Deliberately send once. A timeout is not evidence that a paid submission failed.
    const accepted = await this.request("/command", command);
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const event = await this.request(`/result?id=${encodeURIComponent(accepted.id)}`);
      if (event) {
        if (event.ok === false) throw new Error(`${event.errorCode || "COMMAND_FAILED"}: ${event.error || ""}`);
        return { ...(event.result?.ok === false ? { ok: false } : {}), requestId: accepted.id, canvasUrl: this.canvasUrl, result: event.result };
      }
      await pause(300);
    }
    return { ok: false, submissionState: "unknown", requestId: accepted.id, nextAction: "Use rh_command_result for this request ID. Do not submit again with a new ID." };
  }
}
