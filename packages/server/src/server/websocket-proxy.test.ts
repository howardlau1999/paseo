import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebSocketProxyAgent } from "./websocket-proxy.js";

afterEach(() => vi.unstubAllEnvs());

describe("WebSocket proxy selection", () => {
  it("uses HTTPS_PROXY for secure sockets and bypasses NO_PROXY hosts", () => {
    for (const key of [
      "http_proxy",
      "https_proxy",
      "all_proxy",
      "no_proxy",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "npm_config_http_proxy",
      "npm_config_https_proxy",
      "npm_config_proxy",
      "npm_config_no_proxy",
    ]) {
      vi.stubEnv(key, "");
    }
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:8889");
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:8888");
    vi.stubEnv("NO_PROXY", "localhost,127.0.0.1");

    const agent = createWebSocketProxyAgent("wss://relay.example.com/ws");
    expect(agent?.proxy.href).toBe("http://127.0.0.1:8888/");
    expect(createWebSocketProxyAgent("ws://hub.example.com/ws")?.proxy.href).toBe(
      "http://127.0.0.1:8889/",
    );
    expect(createWebSocketProxyAgent("wss://localhost:443/ws")).toBeUndefined();
    expect(createWebSocketProxyAgent("ws://127.0.0.1:6767/ws")).toBeUndefined();
  });
});
