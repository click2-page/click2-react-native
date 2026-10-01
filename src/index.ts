/**
 * click2 deep links for React Native (pure TypeScript; no native code of its own).
 *
 *   import { Linking, Platform } from "react-native";
 *   import AsyncStorage from "@react-native-async-storage/async-storage";
 *   import { Click2 } from "@click2/react-native";
 *
 *   Click2.configure({ hosts: ["acme.click2.page"], platform: Platform.OS, appVersion: "7.2.0", storage: AsyncStorage });
 *   Linking.addEventListener("url", async ({ url }) => route(await Click2.resolve(url)));
 *   const initial = await Linking.getInitialURL(); if (initial) route(await Click2.resolve(initial));
 *
 * Same behaviour as the native SDKs (shared fixtures): only configured hosts are handled and called; the platform's
 * route wins; web-only links open the browser; failures say why.
 */

export type Click2Platform = "ios" | "android";

/** Anything with getItem/setItem (AsyncStorage, MMKV wrappers, a Map in tests). */
export interface Click2Storage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem?(key: string): Promise<void>;
}

export interface Click2Config {
  /** The team's link hosts, e.g. ["acme.click2.page"] (staging builds: ["acme-test.click2.page"]). */
  hosts: string[];
  platform: Click2Platform | string;
  appVersion?: string;
  storage?: Click2Storage;
  /** Total time per call (default 10 s). */
  timeoutMs?: number;
  /** How long the last link that opened the app gets credit for track() events (default 7 days). */
  attributionWindowMs?: number;
  /** Android: returns the Play install referrer (e.g. from react-native-play-install-referrer), for deferred links. */
  readInstallReferrer?: () => Promise<string | null | undefined>;
  fetch?: typeof fetch;
  logging?: boolean;
}

export interface Click2Link {
  url: string;
  alias?: string;
  deeplinkPath?: string;
  iosDeeplinkPath?: string;
  androidDeeplinkPath?: string;
  webOnly: boolean;
  mobileWebOnly: boolean;
  webUrl?: string;
  iosUrl?: string;
  androidUrl?: string;
  campaign?: string;
  channel?: string;
  feature?: string;
  /** The click2 link itself when `url` was an email click-tracking URL. */
  linkUrl?: string;
  variant?: string;
}

export type Click2FailureReason = "unknown_link" | "invalid_link" | "server_error" | "network_error";

export type Click2Result =
  | { kind: "openRoute"; path: string; link: Click2Link }
  | { kind: "openWeb"; url: string; inAppBrowser: boolean; link: Click2Link }
  | { kind: "failed"; reason: Click2FailureReason; url: string }
  | { kind: "notAClick2Link" };

const SERVICE_PATHS = new Set(["api", "hooks", ".well-known", "robots.txt", "favicon.ico", "apple-app-site-association"]);
const normalizeHost = (h: string) => h.toLowerCase().replace(/\.+$/, "");

/** The normalized host of a click2 link on `hosts`, or undefined. Lenient about characters browsers leave unencoded. */
export function linkHost(url: string, hosts: string[]): string | undefined {
  const m = /^https:\/\/([^/?#]*)([^?#]*)/i.exec(url.trim());
  if (!m) return undefined;
  const authority = m[1]!;
  if (authority.includes("@")) return undefined;
  const [hostPart, port] = authority.split(":");
  if (port !== undefined && port !== "443") return undefined;
  const host = normalizeHost(hostPart ?? "");
  if (!hosts.map((h) => normalizeHost(h.trim())).includes(host)) return undefined;
  const path = (m[2] ?? "").replace(/^\/+|\/+$/g, "");
  if (!path) return undefined;
  const [first = "", rest] = [path.split("/")[0], path.split("/").slice(1).join("/")];
  let decoded = first;
  try {
    decoded = decodeURIComponent(first);
  } catch {
    /* keep as is */
  }
  if (SERVICE_PATHS.has(decoded.toLowerCase())) return undefined;
  if (decoded === "p" && !rest?.replace(/^\/+|\/+$/g, "")) return undefined;
  return host;
}

/** Only absolute http(s) URLs with a host, spaces and the like percent-encoded; anything else is dropped. */
function webUrl(v: unknown): string | undefined {
  if (typeof v !== "string" || !v) return undefined;
  // As given, only characters that can't appear in a URL encoded (like the native SDKs).
  const encoded = v.trim().replace(/[\s"<>\\^`{|}]/g, (ch) => encodeURIComponent(ch));
  try {
    const u = new URL(encoded);
    return (u.protocol === "https:" || u.protocol === "http:") && u.hostname ? encoded : undefined;
  } catch {
    return undefined;
  }
}
const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
const bool = (v: unknown) => v === true || v === 1 || v === "true" || v === "1";

/** A /api/v1/resolve answer → what the app should do (spec/fixtures/resolution.json). */
export function mapResolve(clickedUrl: string, platform: string, status: number, body: unknown): Click2Result {
  if (status === 404) return { kind: "failed", reason: "unknown_link", url: clickedUrl };
  if (status === 400) return { kind: "failed", reason: "invalid_link", url: clickedUrl };
  if (status !== 200 || !body || typeof body !== "object" || Array.isArray(body)) return { kind: "failed", reason: "server_error", url: clickedUrl };
  const j = body as Record<string, unknown>;
  const base = webUrl(j.webUrl);
  const link: Click2Link = {
    url: clickedUrl,
    alias: str(j.alias),
    deeplinkPath: str(j.deeplinkPath),
    iosDeeplinkPath: str(j.iosDeeplinkPath),
    androidDeeplinkPath: str(j.androidDeeplinkPath),
    webOnly: bool(j.webOnly),
    mobileWebOnly: bool(j.mobileWebOnly),
    webUrl: base,
    iosUrl: webUrl(j.iosUrl) ?? base,
    androidUrl: webUrl(j.androidUrl) ?? base,
    campaign: str(j.campaign),
    channel: str(j.channel),
    feature: str(j.feature),
    linkUrl: webUrl(j.link),
    variant: str(j.variant),
  };
  const platformUrl = platform === "ios" ? link.iosUrl : link.androidUrl;
  const route = [platform === "ios" ? link.iosDeeplinkPath : link.androidDeeplinkPath, link.deeplinkPath]
    .map((r) => r?.trim())
    .find((r) => !!r)
    ?.replace(/^\/+/, "");
  const web = (inAppBrowser: boolean): Click2Result => (platformUrl ? { kind: "openWeb", url: platformUrl, inAppBrowser, link } : { kind: "failed", reason: "server_error", url: clickedUrl });
  if (link.webOnly) return web(false);
  if (link.mobileWebOnly) return web(true);
  if (route) return { kind: "openRoute", path: route, link };
  return web(true);
}

/** The first click2 link in pasted text. */
export function linkInText(text: string, hosts: string[]): string | undefined {
  for (const m of text.matchAll(/https:\/\/[^\s<>"']+/gi)) {
    const candidate = m[0].replace(/[).,!?;:]+$/, "");
    if (linkHost(candidate, hosts)) return candidate;
  }
  return undefined;
}

/** The click2 link carried in a Play install referrer (smartlink=<encoded link>). */
export function linkFromReferrer(referrer: string | null | undefined, hosts: string[]): string | undefined {
  if (!referrer?.trim()) return undefined;
  // Percent-only decoding (a "+" in the link, sent as %2B, stays a "+"); some Play Store versions encode it once more.
  const decode = (t: string) => {
    try {
      return decodeURIComponent(t);
    } catch {
      return t;
    }
  };
  const text = referrer.includes("=") ? referrer : decode(referrer);
  if (!text.includes("=")) return undefined;
  const pair = text.split("&").map((p) => p.split(/=(.*)/s)).find((p) => p.length >= 2 && decode(p[0]!).trim() === "smartlink");
  const link = pair ? decode(pair[1]!).trim() : "";
  return link && linkHost(link, hosts) ? link : undefined;
}

const K = { tracking: "click2.tracking", install: "click2.install_reported", user: "click2.user_id", last: "click2.last_link", referrer: "click2.referrer_checked" };

class Click2Sdk {
  private config?: Required<Pick<Click2Config, "hosts" | "platform" | "timeoutMs" | "attributionWindowMs">> & Click2Config;
  private memory = new Map<string, string>();

  configure(config: Click2Config) {
    if (!config.hosts.length) throw new Error("Click2.configure needs at least one host");
    this.config = { timeoutMs: 10_000, attributionWindowMs: 7 * 86_400_000, ...config };
  }

  private get c() {
    if (!this.config) throw new Error("Call Click2.configure(...) first");
    return this.config;
  }
  private async get(key: string) {
    return this.c.storage ? this.c.storage.getItem(key) : (this.memory.get(key) ?? null);
  }
  private async set(key: string, value: string | null) {
    if (value === null) {
      if (this.c.storage?.removeItem) await this.c.storage.removeItem(key);
      else if (this.c.storage) await this.c.storage.setItem(key, "");
      else this.memory.delete(key);
      return;
    }
    if (this.c.storage) await this.c.storage.setItem(key, value);
    else this.memory.set(key, value);
  }
  private log(m: string) {
    if (this.c.logging) console.log(`[Click2] ${m}`);
  }

  /** Whether opens, installs and events are recorded (consent). Default true. */
  async isTrackingEnabled() {
    return (await this.get(K.tracking)) !== "0";
  }
  async setTrackingEnabled(on: boolean) {
    await this.set(K.tracking, on ? "1" : "0");
  }
  /** Your user id (sent with installs and events for integrations like Braze); null after sign-out. */
  async setUserId(id: string | null) {
    const v = id?.trim().slice(0, 128);
    await this.set(K.user, v ? v : null);
  }

  isClick2Link(url: string | null | undefined) {
    return !!url && !!linkHost(url, this.c.hosts);
  }

  private async request(method: "GET" | "POST", url: string, body?: unknown): Promise<{ status: number; json: unknown } | undefined> {
    const f = this.c.fetch ?? fetch;
    const headers: Record<string, string> = { accept: "application/json", "x-click2-sdk": `react-native/0.3.0` };
    if (!(await this.isTrackingEnabled())) headers["x-tracking-disabled"] = "1";
    if (body !== undefined) headers["content-type"] = "application/json";
    for (let attempt = 1; attempt <= 2; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.c.timeoutMs);
      try {
        const res = await f(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal });
        const text = await res.text();
        let json: unknown;
        try {
          json = text ? JSON.parse(text) : undefined;
        } catch {
          json = undefined;
        }
        return { status: res.status, json };
      } catch (err) {
        this.log(`${method} failed (attempt ${attempt}): ${String(err)}`);
        // Retry a GET once on a network failure; never a POST (it may have arrived).
        if (method !== "GET" || ctrl.signal.aborted) return undefined;
      } finally {
        clearTimeout(timer);
      }
    }
    return undefined;
  }

  /** Resolves a click2 link (Universal Link / App Link / custom handling); notAClick2Link for anything else. */
  async resolve(url: string): Promise<Click2Result> {
    const host = linkHost(url, this.c.hosts);
    if (!host) return { kind: "notAClick2Link" };
    const q = new URLSearchParams({ url, platform: String(this.c.platform) });
    if (this.c.appVersion) q.set("appVersion", this.c.appVersion.slice(0, 32));
    const res = await this.request("GET", `https://${host}/api/v1/resolve?${q}`);
    const result = res ? mapResolve(url, String(this.c.platform), res.status, res.json) : ({ kind: "failed", reason: "network_error", url } as const);
    if (result.kind === "openRoute" || result.kind === "openWeb") {
      await this.set(K.last, JSON.stringify({ url: result.link.linkUrl ?? url, host, at: Date.now(), variant: result.link.variant }));
    }
    return result;
  }

  /**
   * Deferred deep link from a pasted link (iOS: the click2 page copies it before the App Store) — also reports the
   * install, once. Returns null when the text has no click2 link.
   */
  async handleDeferredLink(textOrUrl: string): Promise<Click2Result | null> {
    const link = linkInText(textOrUrl, this.c.hosts);
    if (!link) return null;
    void this.reportInstall(link);
    return this.resolve(link);
  }

  /** Android: the deferred deep link from the Play install referrer, on the first launch only. */
  async checkDeferredLink(): Promise<Click2Result | null> {
    if (this.c.platform !== "android" || !this.c.readInstallReferrer || (await this.get(K.referrer)) === "1") return null;
    const referrer = await this.c.readInstallReferrer().catch(() => undefined);
    if (referrer === undefined) return null; // not available yet: try next launch
    await this.set(K.referrer, "1");
    const link = linkFromReferrer(referrer, this.c.hosts);
    if (!link) {
      // A Play Store campaign without a click2 link: click2 reads its UTM tags.
      if (referrer && referrer.includes("utm_") && (await this.isTrackingEnabled())) {
        void this.request("POST", `https://${this.c.hosts[0]}/api/v1/events`, { type: "install", referrer: referrer.slice(0, 1000), platform: "android", appVersion: this.c.appVersion, userId: (await this.get(K.user)) || undefined });
      }
      return null;
    }
    void this.reportInstall(link);
    return this.resolve(link);
  }

  private async reportInstall(link: string) {
    if (!(await this.isTrackingEnabled()) || (await this.get(K.install)) === "1") return;
    const host = linkHost(link, this.c.hosts)!;
    const res = await this.request("POST", `https://${host}/api/v1/events`, { type: "install", url: link, platform: String(this.c.platform), appVersion: this.c.appVersion, userId: (await this.get(K.user)) || undefined });
    if (res && res.status < 500) await this.set(K.install, "1");
  }

  /** In-app event (e.g. track("purchase", { revenue: 24.99, currency: "USD" })), credited to the last link (7 days). */
  async track(name: string, options: { revenue?: number; currency?: string; properties?: Record<string, string | number | boolean> } = {}): Promise<boolean> {
    if (!(await this.isTrackingEnabled())) return false;
    let link: string | undefined;
    let variant: string | undefined;
    let host = this.c.hosts[0]!;
    try {
      const last = JSON.parse((await this.get(K.last)) || "null") as { url: string; host: string; at: number; variant?: string } | null;
      const age = last ? Date.now() - last.at : -1;
      if (last && age >= 0 && age <= this.c.attributionWindowMs && this.c.hosts.map(normalizeHost).includes(last.host)) {
        link = last.url;
        variant = last.variant;
        host = last.host;
      }
    } catch {
      /* no attribution */
    }
    const res = await this.request("POST", `https://${host}/api/v1/events`, {
      type: "event",
      name,
      ...options,
      url: link,
      variant,
      platform: String(this.c.platform),
      appVersion: this.c.appVersion,
      userId: (await this.get(K.user)) || undefined,
    });
    return !!res && res.status >= 200 && res.status < 300;
  }
}

export const Click2 = new Click2Sdk();
export { Click2Sdk };
