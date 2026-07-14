import assert from "node:assert/strict";
import test from "node:test";
import { DATA_STATUS } from "../src/config.js";
import { LiveTracker } from "../src/live-tracker.js";

test("WebSocket failure switches to REST polling", async () => {
  let polls = 0;
  const statuses = [];
  class FailedSocket {
    constructor() { queueMicrotask(() => this.onerror?.()); }
    close() {}
  }
  const tracker = new LiveTracker({
    websocketUrl: "wss://worker.example/v1/stream",
    websocketEnabled: true,
    WebSocketFactory: FailedSocket,
    poll: async () => { polls += 1; },
    intervalMs: 60_000,
    onStatus: (status) => statuses.push(status),
  });
  tracker.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  tracker.stop();
  assert.equal(polls, 1);
  assert.ok(statuses.includes(DATA_STATUS.POLLING));
});
