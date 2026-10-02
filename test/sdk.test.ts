import { beforeEach, describe, expect, it, vi } from "vitest";
import { Click2Sdk, isCampaignReferrer, linkFromReferrer, linkHost, linkInText, mapResolve, type Click2Storage } from "../src/index";
import matching from "./fixtures/link-matching.json";
import resolution from "./fixtures/resolution.json";
import pasted from "./fixtures/pasted-text.json";
import referrer from "./fixtures/install-referrer.json";
import campaign from "./fixtures/campaign-referrer.json";

describe("shared fixtures (same as the native SDKs)", () => {
  for (const c of matching.cases) it(`link matching: ${c.url}`, () => expect(!!linkHost(c.url, matching.hosts)).toBe(c.expected));
  for (const c of resolution.cases as { name: string; platform: string; status: number; body: unknown; expected: Record<string, unknown> }[]) {
    it(`resolution: ${c.name}`, () => {
      const r = mapResolve("https://acme.click2.page/x", c.platform, c.status, c.body);
      const e = c.expected;
      if (e.action === "route") expect(r).toMatchObject({ kind: "openRoute", path: e.path });
      else if (e.action === "web") expect(r).toMatchObject({ kind: "openWeb", url: e.url, inAppBrowser: e.inAppBrowser });
      else expect(r).toMatchObject({ kind: "failed", reason: e.reason });
    });
  }
  for (const c of pasted.cases as { text: string; expected: string | null }[]) it(`pasted text: ${JSON.stringify(c.text).slice(0, 40)}`, () => expect(linkInText(c.text, pasted.hosts) ?? null).toBe(c.expected));
  for (const c of referrer.cases as { referrer: string; expected: string | null }[]) it(`referrer: ${c.referrer.slice(0, 40)}`, () => expect(linkFromReferrer(c.referrer, referrer.hosts) ?? null).toBe(c.expected));
  for (const c of campaign.cases) it(`campaign referrer: ${c.referrer.slice(0, 50)}`, () => expect(isCampaignReferrer(c.referrer)).toBe(c.report));
});

describe("SDK flows", () => {
  let calls: { method: string; url: string; body?: Record<string, unknown>; headers: Record<string, string> }[];
  let sdk: Click2Sdk;
  const answer = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status });
  beforeEach(() => {
    calls = [];
    sdk = new Click2Sdk();
    const store = new Map<string, string>();
    sdk.configure({
      storage: { getItem: async (k) => store.get(k) ?? null, setItem: async (k, v) => void store.set(k, v) },
      hosts: ["acme.click2.page"],
      platform: "ios",
      appVersion: "7.2.0",
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ method: String(init.method), url, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: init.headers as Record<string, string> });
        if (url.includes("/api/v1/resolve")) return answer(200, { alias: "fall", deeplinkPath: "deals/fall", webOnly: false, mobileWebOnly: false, webUrl: "https://www.acme.com", variant: "b" });
        return answer(204, {});
      }) as unknown as typeof fetch,
    });
  });

  it("resolves on the link's host and credits later events to it", async () => {
    expect(await sdk.resolve("https://evil.com/x")).toEqual({ kind: "notAClick2Link" });
    const r = await sdk.resolve("https://acme.click2.page/fall?src=sms");
    expect(r).toMatchObject({ kind: "openRoute", path: "deals/fall" });
    const u = new URL(calls[0]!.url);
    expect(u.host + u.pathname).toBe("acme.click2.page/api/v1/resolve");
    expect(u.searchParams.get("url")).toBe("https://acme.click2.page/fall?src=sms");
    await sdk.setUserId("u-1");
    expect(await sdk.track("purchase", { revenue: 5, currency: "USD" })).toBe(true);
    expect(calls.at(-1)!.body).toMatchObject({ type: "event", name: "purchase", revenue: 5, url: "https://acme.click2.page/fall?src=sms", variant: "b", userId: "u-1" });
  });

  it("deferred link from pasted text reports the install once; tracking off sends the header and no events", async () => {
    // At the same time (StrictMode double effects) and again later.
    await Promise.all([sdk.handleDeferredLink("Open https://acme.click2.page/fall now"), sdk.handleDeferredLink("https://acme.click2.page/fall")]);
    await sdk.handleDeferredLink("https://acme.click2.page/fall");
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.filter((c) => c.body?.type === "install")).toHaveLength(1);
    await sdk.setTrackingEnabled(false);
    expect(await sdk.track("x")).toBe(false);
    await sdk.resolve("https://acme.click2.page/fall");
    expect(calls.at(-1)!.headers["x-tracking-disabled"]).toBe("1");
  });

  it("Android referrer: a click2 link is resolved; a campaign referrer is reported once", async () => {
    const android = new Click2Sdk();
    let ref = "utm_source=smartlink&smartlink=https%3A%2F%2Facme.click2.page%2Ffall";
    const mem = (): import("../src/index").Click2Storage => { const m = new Map<string, string>(); return { getItem: async (k) => m.get(k) ?? null, setItem: async (k, v) => void m.set(k, v) }; };
    android.configure({ storage: mem(), hosts: ["acme.click2.page"], platform: "android", readInstallReferrer: async () => ref, firstInstallTime: async () => Date.now() - 60_000, fetch: (async (url: string, init: RequestInit) => {
      calls.push({ method: String(init.method), url, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: {} });
      return answer(200, { deeplinkPath: "deals/fall", webOnly: false, mobileWebOnly: false });
    }) as unknown as typeof fetch });
    const [a, b] = await Promise.all([android.checkDeferredLink(), android.checkDeferredLink()]);
    expect(a).toMatchObject({ kind: "openRoute", path: "deals/fall" });
    expect(b).toBe(a); // the same single run
    expect(await android.checkDeferredLink()).toBeNull(); // first launch only
    const old = new Click2Sdk();
    old.configure({ storage: mem(), hosts: ["acme.click2.page"], platform: "android", readInstallReferrer: async () => ref, firstInstallTime: async () => Date.now() - 30 * 86_400_000 });
    expect(await old.checkDeferredLink()).toBeNull(); // installed a month ago: an update, not this click
    const other = new Click2Sdk();
    ref = "utm_source=tiktok&utm_medium=paid";
    other.configure({ storage: mem(), hosts: ["acme.click2.page"], platform: "android", readInstallReferrer: async () => ref, firstInstallTime: async () => Date.now() - 60_000, fetch: (async (url: string, init: RequestInit) => {
      calls.push({ method: String(init.method), url, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: {} });
      return answer(204, {});
    }) as unknown as typeof fetch });
    expect(await other.checkDeferredLink()).toBeNull();
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.at(-1)!.body).toMatchObject({ type: "install", referrer: "utm_source=tiktok&utm_medium=paid" });
  });

  it("install reports answered with 429 or 408 are sent again with the next deferred link", async () => {
    const statuses = [429, 408, 204];
    const posts: number[] = [];
    const store = new Map<string, string>();
    sdk.configure({ storage: { getItem: async (k) => store.get(k) ?? null, setItem: async (k, v) => void store.set(k, v) }, hosts: ["acme.click2.page"], platform: "ios", fetch: (async (url: string) => {
      if (url.includes("/api/v1/resolve")) return answer(200, { deeplinkPath: "deals/fall", webOnly: false, mobileWebOnly: false });
      const status = statuses.shift() ?? 204;
      posts.push(status);
      return answer(status, {});
    }) as unknown as typeof fetch });
    for (let i = 0; i < 4; i++) {
      await sdk.handleDeferredLink("https://acme.click2.page/fall");
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(posts).toEqual([429, 408, 204]);
    expect(store.get("click2.install_reported")).toBe("1");
  });

  it("a failed GET is not retried (it may have counted the open)", async () => {
    let gets = 0;
    sdk.configure({ hosts: ["acme.click2.page"], platform: "ios", fetch: (async () => {
      gets++;
      throw new TypeError("Network request failed");
    }) as unknown as typeof fetch });
    expect(await sdk.resolve("https://acme.click2.page/fall")).toMatchObject({ kind: "failed", reason: "network_error" });
    expect(gets).toBe(1);
  });

  it("hosts are normalized once and validated", async () => {
    sdk.configure({ hosts: [" Acme.Click2.Page. ", "acme.click2.page"], platform: "ios", fetch: (async (url: string, init: RequestInit) => {
      calls.push({ method: String(init.method), url, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: {} });
      if (url.includes("/api/v1/resolve")) return answer(200, { deeplinkPath: "deals/fall", webOnly: false, mobileWebOnly: false });
      return answer(204, {});
    }) as unknown as typeof fetch });
    expect(sdk.isClick2Link("https://ACME.click2.page./fall")).toBe(true);
    await sdk.resolve("https://ACME.click2.page./fall");
    expect(calls[0]!.url.startsWith("https://acme.click2.page/api/v1/resolve?")).toBe(true);
    await sdk.track("purchase");
    expect(calls.at(-1)!.url).toBe("https://acme.click2.page/api/v1/events");
    expect(calls.at(-1)!.body).toMatchObject({ url: "https://ACME.click2.page./fall" });
    for (const bad of ["https://acme.click2.page", "acme.click2.page/x", "acme.click2.page:443", "user@acme.click2.page", "acme_shop.click2.page", ""]) {
      expect(() => sdk.configure({ hosts: [bad], platform: "ios" }), bad).toThrow(/bare host name/);
    }
  });
});

describe("Android deferred links", () => {
  type Answer = number | "offline";
  const mem = () => {
    const m = new Map<string, string>();
    const storage: Click2Storage = { getItem: async (k) => m.get(k) ?? null, setItem: async (k, v) => void m.set(k, v) };
    return { m, storage };
  };
  const link = "https://acme.click2.page/fall";
  const smartlink = `utm_source=smartlink&smartlink=${encodeURIComponent(link)}`;
  const settle = () => new Promise((r) => setTimeout(r, 5));

  /** One app launch: a fresh SDK instance on the same storage. */
  function launch(storage: Click2Storage, opts: { referrer?: string; resolve?: Answer; install?: Answer; installedAgo?: number; firstInstallTime?: boolean } = {}) {
    const log = { resolves: 0, installs: [] as Record<string, unknown>[], referrerReads: 0 };
    const sdk = new Click2Sdk();
    const reply = (a: Answer, body: unknown) => (a === "offline" ? Promise.reject(new TypeError("Network request failed")) : Promise.resolve(new Response(a === 204 ? null : JSON.stringify(body), { status: a })));
    sdk.configure({
      storage,
      hosts: ["acme.click2.page"],
      platform: "android",
      readInstallReferrer: async () => (log.referrerReads++, opts.referrer ?? smartlink),
      firstInstallTime: opts.firstInstallTime === false ? undefined : async () => Date.now() - (opts.installedAgo ?? 60_000),
      fetch: (async (url: string, init: RequestInit) => {
        if (url.includes("/api/v1/resolve")) {
          log.resolves++;
          return reply(opts.resolve ?? 200, { deeplinkPath: "deals/fall", webOnly: false, mobileWebOnly: false });
        }
        log.installs.push(JSON.parse(String(init.body)));
        return reply(opts.install ?? 204, {});
      }) as unknown as typeof fetch,
    });
    return { sdk, log };
  }

  it("an organic Play install or another host's link reports nothing", async () => {
    for (const referrer of ["utm_source=google-play&utm_medium=organic", "utm_source=smartlink&smartlink=https%3A%2F%2Fglobex.click2.page%2Fx"]) {
      const { sdk, log } = launch(mem().storage, { referrer });
      expect(await sdk.checkDeferredLink()).toBeNull();
      await settle();
      expect(log.installs, referrer).toEqual([]);
    }
  });

  it("an offline first launch keeps the link and resolves it on the next launch; once per launch", async () => {
    const { storage } = mem();
    const first = launch(storage, { resolve: "offline", install: "offline" });
    expect(await first.sdk.checkDeferredLink()).toMatchObject({ kind: "failed", reason: "network_error" });
    expect(await first.sdk.checkDeferredLink()).toBeNull(); // not again in the same launch
    await settle();
    expect(first.log.resolves).toBe(1);

    const second = launch(storage);
    expect(await second.sdk.checkDeferredLink()).toMatchObject({ kind: "openRoute", path: "deals/fall" });
    await settle();
    expect(second.log.referrerReads).toBe(0);
    expect(second.log.installs).toMatchObject([{ type: "install", url: link }]); // the install that got no answer

    const third = launch(storage);
    expect(await third.sdk.checkDeferredLink()).toBeNull();
    await settle();
    expect(third.log.resolves + third.log.installs.length).toBe(0);
  });

  it("gives up on a pending link after five attempts or the max age; an unknown link isn't retried", async () => {
    const { storage, m } = mem();
    for (let i = 0; i < 5; i++) expect(await launch(storage, { resolve: 503 }).sdk.checkDeferredLink()).toMatchObject({ kind: "failed", reason: "server_error" });
    expect(m.get("click2.pending_link") || null).toBeNull();
    const after = launch(storage);
    expect(await after.sdk.checkDeferredLink()).toBeNull();
    expect(after.log.resolves).toBe(0);

    const old = mem();
    await launch(old.storage, { resolve: "offline" }).sdk.checkDeferredLink();
    const late = launch(old.storage, { installedAgo: 8 * 86_400_000 });
    expect(await late.sdk.checkDeferredLink()).toBeNull();
    expect(late.log.resolves).toBe(0);

    const unknown = mem();
    expect(await launch(unknown.storage, { resolve: 404 }).sdk.checkDeferredLink()).toMatchObject({ kind: "failed", reason: "unknown_link" });
    expect(unknown.m.get("click2.pending_link") || null).toBeNull();
  });

  it("install reports answered with 5xx, 429 or 408 are sent again on later launches", async () => {
    const { storage, m } = mem();
    const statuses: Answer[] = [503, 429, 408, 204];
    let sent = 0;
    for (const install of statuses) {
      const { sdk, log } = launch(storage, { install });
      await sdk.checkDeferredLink();
      await settle();
      sent += log.installs.length;
    }
    expect(sent).toBe(4);
    expect(m.get("click2.install_reported")).toBe("1");
    const done = launch(storage);
    await done.sdk.checkDeferredLink();
    await settle();
    expect(done.log.installs).toEqual([]);
  });

  it("without firstInstallTime the referrer isn't used (warned once)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { sdk, log } = launch(mem().storage, { firstInstallTime: false });
      expect(await sdk.checkDeferredLink()).toBeNull();
      sdk.configure({ hosts: ["acme.click2.page"], platform: "android", storage: mem().storage, readInstallReferrer: async () => smartlink });
      expect(await sdk.checkDeferredLink()).toBeNull();
      expect(log.referrerReads).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
