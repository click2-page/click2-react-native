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
  /**
   * The team's link hosts, e.g. ["acme.click2.page"] (staging builds: ["acme-test.click2.page"]). Bare host names;
   * spaces, letter case and a trailing dot don't matter. The first one gets reports without a link of their own
   * (Play Store campaign installs, events without a recent link), so list a link host first.
   */
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
  /**
   * Android, required with `readInstallReferrer`: when the app was first installed (epoch ms, e.g.
   * react-native-device-info getFirstInstallTime). The referrer is only used within `deferredLinkMaxAgeMs` of it
   * (default 7 days), so an app update shipping the SDK doesn't replay old referrers. Without it the referrer isn't
   * used at all.
   */
  firstInstallTime?: () => Promise<number>;
  deferredLinkMaxAgeMs?: number;
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
/** Trimmed, lowercased, without trailing dots: how hosts are stored and compared. */
const normalizeHost = (h: string) => h.trim().toLowerCase().replace(/\.+$/, "");
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOST_NAME = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})*$`);

/**
 * Decodes %XX escapes and never throws. Runs that aren't valid UTF-8 keep their non-ASCII escapes, but ASCII ones
 * (like %2F) are still decoded, so link matching agrees with the native SDKs.
 */
const percentDecode = (s: string) =>
  s.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run.replace(/%([0-7][0-9a-f])/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    }
  });

/** The normalized host of a click2 link on `hosts`, or undefined. Lenient about characters browsers leave unencoded. */
export function linkHost(url: string, hosts: string[]): string | undefined {
  const m = /^https:\/\/([^/?#]*)([^?#]*)/i.exec(url.trim());
  if (!m) return undefined;
  const authority = m[1]!;
  if (authority.includes("@")) return undefined;
  const [hostPart, port] = authority.split(":");
  if (port !== undefined && port !== "443") return undefined;
  const host = normalizeHost(hostPart ?? "");
  if (!hosts.map(normalizeHost).includes(host)) return undefined;
  // Decoded before splitting (like the native SDKs): an encoded slash (/api%2Fx) ends the first segment too.
  const path = percentDecode(m[2] ?? "").replace(/^\/+|\/+$/g, "");
  if (!path) return undefined;
  const slash = path.indexOf("/");
  const first = slash < 0 ? path : path.slice(0, slash);
  const rest = slash < 0 ? "" : path.slice(slash + 1);
  if (SERVICE_PATHS.has(first.toLowerCase())) return undefined;
  // /p/<route> passthrough links need a route.
  if (first === "p" && !rest.replace(/^\/+|\/+$/g, "")) return undefined;
  return host;
}

/** Only absolute http(s) URLs with a host, spaces and the like percent-encoded; anything else is dropped. */
function webUrl(v: unknown): string | undefined {
  if (typeof v !== "string" || !v) return undefined;
  // As given, only characters that can't appear in a URL encoded (like the native SDKs).
  const encoded = v.trim().replace(/[\s"<>\\^`{|}]/g, (ch) => encodeURIComponent(ch));
  // No URL class: React Native's built-in one (Hermes, RN 0.7x) doesn't implement its getters.
  return /^https?:\/\/[^/?#@\s]+\.[^/?#@\s]+(?:[/?#]|$)/i.test(encoded) ? encoded : undefined;
}

/** a=b&c=d without URLSearchParams (not fully implemented in React Native). */
const query = (params: Record<string, string | undefined>) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v!)}`)
    .join("&");
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

/**
 * Whether a Play install referrer without a click2 link is a campaign worth reporting: UTM tags or a Google Ads click
 * id (test/fixtures/campaign-referrer.json). Not organic Play installs (utm_source=google-play&utm_medium=organic, or
 * google-play with nothing else) nor click2 referrers whose link is for another host.
 */
export function isCampaignReferrer(referrer: string | null | undefined): boolean {
  if (!referrer?.trim()) return false;
  const text = referrer.includes("=") ? referrer : percentDecode(referrer);
  if (!text.includes("=")) return false;
  const params = new Map<string, string>();
  for (const p of text.split("&")) {
    const [k, v] = p.split(/=(.*)/s);
    if (v !== undefined) params.set(percentDecode(k!).trim().toLowerCase(), percentDecode(v).trim().toLowerCase());
  }
  if (params.has("smartlink") || params.get("utm_source") === "smartlink") return false;
  const keys = new Set([...params].filter(([k, v]) => v && (k.startsWith("utm_") || CLICK_IDS.has(k))).map(([k]) => k));
  if (params.get("utm_source") === "google-play") {
    if (params.get("utm_medium") === "organic") return false;
    keys.delete("utm_source");
    keys.delete("utm_medium");
  }
  return keys.size > 0;
}
const CLICK_IDS = new Set(["gclid", "gbraid", "wbraid"]);

/** A final answer to an install report: 2xx, or a 4xx other than 408 (timeout) and 429 (rate limited). */
const isFinal = (status: number) => (status >= 200 && status < 300) || (status >= 400 && status < 500 && status !== 408 && status !== 429);

const K = {
  tracking: "click2.tracking",
  install: "click2.install_reported",
  user: "click2.user_id",
  last: "click2.last_link",
  referrer: "click2.referrer_checked",
  /** Android: a referrer link not resolved yet (offline, server error): {"link", "attempts"}. */
  pending: "click2.pending_link",
  /** Android: a referrer link whose install isn't reported yet. */
  pendingInstall: "click2.pending_install",
};
/** How often a pending referrer link is tried (one per launch), like the Android SDK. */
const MAX_ATTEMPTS = 5;

class Click2Sdk {
  private config?: Required<Pick<Click2Config, "hosts" | "platform" | "timeoutMs" | "attributionWindowMs">> & Click2Config;
  private memory = new Map<string, string>();
  private inFlight = new Map<string, Promise<unknown>>();
  /** The deferred-link check ran in this process (once per launch, like the native SDKs). */
  private deferredDone = false;
  private warnedNoInstallTime = false;

  /** One run at a time per key (StrictMode double effects, remounts, overlapping calls). */
  private once<T>(key: string, work: () => Promise<T>): Promise<T> {
    const running = this.inFlight.get(key) as Promise<T> | undefined;
    if (running) return running;
    const p = work().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }

  configure(config: Click2Config) {
    if (!config.hosts?.length) throw new Error("Click2.configure needs at least one host");
    for (const h of config.hosts) {
      if (typeof h !== "string" || !HOST_NAME.test(normalizeHost(h))) {
        throw new Error(`Invalid click2 host "${String(h)}": use a bare host name like acme.click2.page (no scheme, port, path or user info)`);
      }
    }
    // Normalized once; this list is what's matched, stored and called.
    const hosts = [...new Set(config.hosts.map(normalizeHost))];
    this.config = { timeoutMs: 10_000, attributionWindowMs: 7 * 86_400_000, ...config, hosts };
    this.deferredDone = false;
  }

  private get c() {
    if (!this.config) throw new Error("Call Click2.configure(...) first");
    return this.config;
  }
  private async get(key: string): Promise<string | null> {
    try {
      return this.c.storage ? await this.c.storage.getItem(key) : (this.memory.get(key) ?? null);
    } catch (err) {
      this.log(`storage read failed: ${String(err)}`);
      return null;
    }
  }
  private async set(key: string, value: string | null) {
    try {
      await this.setUnsafe(key, value);
    } catch (err) {
      this.log(`storage write failed: ${String(err)}`);
    }
  }
  private async setUnsafe(key: string, value: string | null) {
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
    const headers: Record<string, string> = { accept: "application/json", "x-click2-sdk": `react-native/0.3.2` };
    if (!(await this.isTrackingEnabled())) headers["x-tracking-disabled"] = "1";
    if (body !== undefined) headers["content-type"] = "application/json";
    // No retry: fetch doesn't say whether a failed request reached the server, and a repeated resolve or report
    // could count the open or install twice.
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
      this.log(`${method} failed: ${String(err)}`);
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Resolves a click2 link (Universal Link / App Link / custom handling); notAClick2Link for anything else. */
  async resolve(url: string): Promise<Click2Result> {
    const host = linkHost(url, this.c.hosts);
    if (!host) return { kind: "notAClick2Link" };
    const q = query({ url, platform: String(this.c.platform), appVersion: this.c.appVersion?.slice(0, 32) });
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
    void this.reportInstall(link).catch(() => undefined);
    return this.resolve(link);
  }

  /** For apps that recorded installs themselves before: never report an install from this device. */
  async markInstallReported() {
    await this.set(K.install, "1");
  }

  /** For apps that handled deferred links themselves before: don't read this install's referrer. */
  async markDeferredLinkChecked() {
    await this.set(K.referrer, "1");
  }

  /**
   * Android: the deferred deep link from the Play install referrer, on the first launch after the install. Needs
   * `storage`, `readInstallReferrer` and `firstInstallTime`. Once per launch (concurrent calls share the run). A link
   * that can't be resolved yet (offline, server error) is kept and tried again on later launches, up to 5 times
   * within `deferredLinkMaxAgeMs`; an install report that got no final answer is sent again too.
   */
  checkDeferredLink(): Promise<Click2Result | null> {
    if (this.deferredDone) return Promise.resolve(null);
    return this.once("deferred", () => this.checkDeferredLinkNow().finally(() => (this.deferredDone = true)));
  }

  private async checkDeferredLinkNow(): Promise<Click2Result | null> {
    if (this.c.platform !== "android" || !this.c.readInstallReferrer) return null;
    // Without persistent storage every cold start would replay the referrer.
    if (!this.c.storage) {
      this.log("checkDeferredLink needs `storage` (e.g. AsyncStorage); skipped");
      return null;
    }
    // Without the install time an app update shipping the SDK would replay an old referrer as a new install.
    if (!this.c.firstInstallTime) {
      if (!this.warnedNoInstallTime) {
        this.warnedNoInstallTime = true;
        console.warn("[Click2] checkDeferredLink needs `firstInstallTime` (e.g. react-native-device-info getFirstInstallTime); the install referrer is not used");
      }
      return null;
    }
    const installed = await this.c.firstInstallTime().catch(() => 0);
    const fresh = Date.now() - installed <= (this.c.deferredLinkMaxAgeMs ?? 7 * 86_400_000);

    if ((await this.get(K.referrer)) === "1") {
      // A later launch: finish what the first one couldn't.
      const pendingInstall = await this.get(K.pendingInstall);
      if (pendingInstall) {
        if (fresh) void this.reportInstall(pendingInstall).catch(() => undefined);
        else await this.set(K.pendingInstall, null);
      }
      const pending = this.parsePending(await this.get(K.pending));
      if (!pending) return null;
      if (!fresh || pending.attempts >= MAX_ATTEMPTS) {
        await this.set(K.pending, null);
        return null;
      }
      return this.resolvePending(pending.link, pending.attempts);
    }
    if (!fresh) {
      // An update or restore long after the install: the referrer isn't this user's click.
      await this.set(K.referrer, "1");
      return null;
    }
    const referrer = await this.c.readInstallReferrer().catch(() => undefined);
    if (referrer === undefined) return null; // not available yet: try next launch
    const link = linkFromReferrer(referrer, this.c.hosts);
    const tracking = await this.isTrackingEnabled();
    // Saved before anything is sent, so the link and its install survive the app being killed.
    await this.set(K.pending, link ? JSON.stringify({ link, attempts: 0 }) : null);
    await this.set(K.pendingInstall, link && tracking ? link : null);
    await this.set(K.referrer, "1");
    if (!link) {
      // A Play Store campaign without a click2 link: click2 reads its UTM tags (once, best effort).
      if (tracking && isCampaignReferrer(referrer)) {
        void this.request("POST", `https://${this.c.hosts[0]}/api/v1/events`, { type: "install", referrer: referrer!.slice(0, 4000), platform: "android", appVersion: this.c.appVersion, userId: (await this.get(K.user)) || undefined }).catch(() => undefined);
      }
      return null;
    }
    if (tracking) void this.reportInstall(link).catch(() => undefined);
    return this.resolvePending(link, 0);
  }

  private parsePending(value: string | null): { link: string; attempts: number } | undefined {
    try {
      const p = JSON.parse(value || "null") as { link?: unknown; attempts?: unknown } | null;
      if (p && typeof p.link === "string" && linkHost(p.link, this.c.hosts)) return { link: p.link, attempts: typeof p.attempts === "number" ? p.attempts : 0 };
    } catch {
      /* none */
    }
    return undefined;
  }

  private async resolvePending(link: string, attemptsBefore: number): Promise<Click2Result> {
    const attempts = attemptsBefore + 1;
    await this.set(K.pending, JSON.stringify({ link, attempts }));
    const result = await this.resolve(link);
    const transient = result.kind === "failed" && (result.reason === "network_error" || result.reason === "server_error");
    if (!transient || attempts >= MAX_ATTEMPTS) await this.set(K.pending, null);
    return result;
  }

  private reportInstall(link: string): Promise<void> {
    return this.once("install", () => this.reportInstallNow(link));
  }

  private async reportInstallNow(link: string) {
    if (!(await this.isTrackingEnabled())) {
      // Consent withdrawn: a pending report is dropped, like the native SDKs.
      await this.set(K.pendingInstall, null);
      return;
    }
    if ((await this.get(K.install)) === "1") return;
    if (!this.c.storage) return this.log("install reports need `storage` (e.g. AsyncStorage); skipped");
    const host = linkHost(link, this.c.hosts);
    if (!host) return;
    const res = await this.request("POST", `https://${host}/api/v1/events`, { type: "install", url: link, platform: String(this.c.platform), appVersion: this.c.appVersion, userId: (await this.get(K.user)) || undefined });
    // No answer, 5xx, 408 or 429: tried again later (the next deferred link, or the next launch on Android).
    if (res && isFinal(res.status)) {
      await this.set(K.install, "1");
      await this.set(K.pendingInstall, null);
    }
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
      if (last && age >= 0 && age <= this.c.attributionWindowMs && this.c.hosts.includes(last.host)) {
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
