import { DATA_STATUS } from "./config.js";

export class LiveTracker {
  constructor({
    websocketUrl,
    websocketEnabled = false,
    WebSocketFactory = globalThis.WebSocket,
    poll,
    intervalMs = 15 * 60 * 1000,
    websocketTimeoutMs = 4_000,
    setIntervalImpl = globalThis.setInterval,
    clearIntervalImpl = globalThis.clearInterval,
    setTimeoutImpl = globalThis.setTimeout,
    clearTimeoutImpl = globalThis.clearTimeout,
    onStatus = () => {},
    onMessage = () => {},
  }) {
    this.websocketUrl = websocketUrl;
    this.websocketEnabled = websocketEnabled;
    this.WebSocketFactory = WebSocketFactory;
    this.poll = poll;
    this.intervalMs = intervalMs;
    this.websocketTimeoutMs = websocketTimeoutMs;
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.onStatus = onStatus;
    this.onMessage = onMessage;
    this.socket = null;
    this.pollTimer = null;
    this.connectTimer = null;
  }

  async start() {
    this.stop();
    this.onStatus(DATA_STATUS.CONNECTING);
    if (!this.websocketEnabled || !this.WebSocketFactory || !this.websocketUrl) return this.startPolling();
    try {
      this.socket = new this.WebSocketFactory(this.websocketUrl);
      this.connectTimer = this.setTimeoutImpl(() => this.fallbackFromWebSocket("WebSocket connection timed out"), this.websocketTimeoutMs);
      this.socket.onopen = () => {
        this.clearTimeoutImpl(this.connectTimer);
        this.onStatus(DATA_STATUS.WEBSOCKET);
      };
      this.socket.onmessage = (event) => {
        try { this.onMessage(JSON.parse(event.data)); } catch { /* Invalid messages do not replace good data. */ }
      };
      this.socket.onerror = () => this.fallbackFromWebSocket("WebSocket error");
      this.socket.onclose = () => this.fallbackFromWebSocket("WebSocket closed");
      return DATA_STATUS.CONNECTING;
    } catch {
      return this.startPolling();
    }
  }

  async fallbackFromWebSocket() {
    if (this.pollTimer) return;
    if (this.socket) {
      this.socket.onclose = null;
      try { this.socket.close(); } catch { /* Already closed. */ }
      this.socket = null;
    }
    return this.startPolling();
  }

  async startPolling() {
    this.clearTimeoutImpl(this.connectTimer);
    await this.poll();
    this.onStatus(DATA_STATUS.POLLING);
    this.pollTimer = this.setIntervalImpl(() => this.poll(), this.intervalMs);
    return DATA_STATUS.POLLING;
  }

  stop() {
    this.clearTimeoutImpl(this.connectTimer);
    this.clearIntervalImpl(this.pollTimer);
    this.connectTimer = null;
    this.pollTimer = null;
    if (this.socket) {
      this.socket.onclose = null;
      try { this.socket.close(); } catch { /* Already closed. */ }
      this.socket = null;
    }
  }
}
