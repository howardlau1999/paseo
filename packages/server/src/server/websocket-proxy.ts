import { HttpsProxyAgent } from "https-proxy-agent";
import { getProxyForUrl } from "proxy-from-env";

/** Resolve ws/wss against the same HTTP(S) proxy and NO_PROXY settings as fetch. */
export function createWebSocketProxyAgent(url: string): HttpsProxyAgent<string> | undefined {
  const target = new URL(url);
  if (target.protocol === "ws:") {
    target.protocol = "http:";
  } else if (target.protocol === "wss:") {
    target.protocol = "https:";
  } else {
    return undefined;
  }

  const proxyUrl = getProxyForUrl(target.href);
  return proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
}
