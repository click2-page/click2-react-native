import { beforeEach, describe, expect, it } from "vitest";
import { Click2Sdk, linkFromReferrer, linkHost, linkInText, mapResolve } from "../src/index";
import matching from "./fixtures/link-matching.json";
import resolution from "./fixtures/resolution.json";
import pasted from "./fixtures/pasted-text.json";
import referrer from "./fixtures/install-referrer.json";

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
    android.configure({ storage: mem(), hosts: ["acme.click2.page"], platform: "android", readInstallReferrer: async () => ref, fetch: (async (url: string, init: RequestInit) => {
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
    other.configure({ storage: mem(), hosts: ["acme.click2.page"], platform: "android", readInstallReferrer: async () => ref, fetch: (async (url: string, init: RequestInit) => {
      calls.push({ method: String(init.method), url, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: {} });
      return answer(204, {});
    }) as unknown as typeof fetch });
    expect(await other.checkDeferredLink()).toBeNull();
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.at(-1)!.body).toMatchObject({ type: "install", referrer: "utm_source=tiktok&utm_medium=paid" });
  });
});
