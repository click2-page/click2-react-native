/**
 * click2 React Native SDK on a real device / emulator (Hermes, React Native's fetch, AsyncStorage).
 *
 * Runs a self-test against a click2 server and shows the link that opened the app. Each result is logged as
 * "C2TEST PASS|FAIL <name>" and the summary as "C2TEST DONE <passed>/<total>" (adb logcat -s ReactNativeJS).
 * See README.md for running it against a local dev server.
 */
import React, { useEffect, useState } from 'react';
import { Linking, Platform, SafeAreaView, ScrollView, StyleSheet, Text } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Click2, Click2Sdk, linkFromReferrer, linkHost, linkInText, type Click2Result, type Click2Storage } from '@click2/react-native';

/** The team's link host, as in a real app. */
const HOST = 'acme.click2.page';
/** Where requests really go: a local dev server via `adb reverse tcp:8799 tcp:8799` (the SDK always calls https://HOST). */
const SERVER = 'http://localhost:8799';

const viaServer: typeof fetch = (input, init) => fetch(String(input).replace(`https://${HOST}`, SERVER), init);
const deadServer: typeof fetch = (input, init) => fetch(String(input).replace(`https://${HOST}`, 'http://localhost:1'), init);

function memoryStorage(): Click2Storage {
  const m = new Map<string, string>();
  return {
    getItem: async (k) => m.get(k) ?? null,
    setItem: async (k, v) => void m.set(k, v),
    removeItem: async (k) => void m.delete(k),
  };
}

type Check = { name: string; ok: boolean; detail?: string };

function describe(r: Click2Result | null) {
  if (!r) return 'null';
  if (r.kind === 'openRoute') return `openRoute ${r.path}`;
  if (r.kind === 'openWeb') return `openWeb ${r.url} inApp=${r.inAppBrowser}`;
  if (r.kind === 'failed') return `failed ${r.reason}`;
  return r.kind;
}

async function runSelfTest(log: (c: Check) => void) {
  const check = (name: string, ok: boolean, detail?: string) => log({ name, ok, detail });
  const expectResult = (name: string, r: Click2Result | null, want: string) => check(name, describe(r) === want, describe(r));

  // Pure helpers on Hermes (regex flags, matchAll, decodeURIComponent).
  check('linkHost', linkHost(`https://${HOST.toUpperCase()}/spring?x=1`, [HOST]) === HOST && !linkHost(`https://${HOST}/api/v1/x`, [HOST]));
  check('linkInText', linkInText(`Copied: https://${HOST}/spring.`, [HOST]) === `https://${HOST}/spring`);
  check('linkFromReferrer', linkFromReferrer(`utm_source=google&smartlink=${encodeURIComponent(`https://${HOST}/spring?a=b+c`)}`, [HOST]) === `https://${HOST}/spring?a=b+c`);

  // The app's own instance, as the README sets it up.
  await AsyncStorage.clear();
  let referrerReads = 0;
  Click2.configure({
    hosts: [HOST],
    platform: Platform.OS,
    appVersion: '1.0.0-selftest',
    storage: AsyncStorage,
    fetch: viaServer,
    logging: true,
    readInstallReferrer: async () => {
      referrerReads++;
      return `utm_source=selftest&smartlink=${encodeURIComponent(`https://${HOST}/spring`)}`;
    },
    firstInstallTime: async () => Date.now() - 60_000,
  });

  expectResult('resolve route', await Click2.resolve(`https://${HOST}/spring`), 'openRoute product/42');
  const spring = await Click2.resolve(`https://${HOST}/spring`);
  check('link tags', spring.kind === 'openRoute' && spring.link.campaign === 'spring-sale' && spring.link.channel === 'email', JSON.stringify(spring.kind === 'openRoute' ? spring.link : spring));
  expectResult('resolve web only', await Click2.resolve(`https://${HOST}/webonly`), 'openWeb https://www.example.com/terms inApp=false');
  expectResult('platform route', await Click2.resolve(`https://${HOST}/droid`), `openRoute ${Platform.OS}/home`);
  expectResult('passthrough /p/', await Click2.resolve(`https://${HOST}/p/cart?coupon=X`), 'openRoute cart?coupon=X');
  expectResult('unknown link', await Click2.resolve(`https://${HOST}/no-such-link`), 'failed unknown_link');
  expectResult('not a click2 link', await Click2.resolve('https://www.example.com/spring'), 'notAClick2Link');
  const ab = await Click2.resolve(`https://${HOST}/ab`);
  check('A/B variant', ab.kind === 'openRoute' && ['a', 'b'].includes(ab.link.variant ?? '') && ab.path === (ab.link.variant === 'b' ? 'variant-b' : 'control'), `${describe(ab)} variant=${ab.kind === 'openRoute' ? ab.link.variant : '-'}`);

  // Persistence: the last link is stored in AsyncStorage for event attribution.
  const last = JSON.parse((await AsyncStorage.getItem('click2.last_link')) ?? 'null');
  check('last link stored', last?.url === `https://${HOST}/ab` && last?.host === HOST, JSON.stringify(last));

  await Click2.setUserId('selftest-user-42');
  check('track purchase', await Click2.track('purchase', { revenue: 9.99, currency: 'USD', properties: { sku: 'A1' } }));

  // Deferred link (Android: Play install referrer). Concurrent calls share one run; the second launch gets nothing.
  if (Platform.OS === 'android') {
    const [d1, d2] = await Promise.all([Click2.checkDeferredLink(), Click2.checkDeferredLink()]);
    expectResult('deferred link', d1, 'openRoute product/42');
    check('deferred once (concurrent)', d1 === d2 && referrerReads === 1, `reads=${referrerReads}`);
    expectResult('deferred link next launch', await Click2.checkDeferredLink(), 'null');
    await new Promise<void>((r) => setTimeout(r, 500));
    check('install reported', (await AsyncStorage.getItem('click2.install_reported')) === '1');
  }

  // iOS-style deferred link from pasted text (separate instance and storage).
  const ios = new Click2Sdk();
  ios.configure({ hosts: [HOST], platform: 'ios', storage: memoryStorage(), fetch: viaServer });
  expectResult('pasted link', await ios.handleDeferredLink(`Open https://${HOST}/droid now`), 'openRoute ios/home');
  check('pasted text without link', (await ios.handleDeferredLink('hello')) === null);

  // Network failure: AbortController and timeout on Hermes.
  const offline = new Click2Sdk();
  offline.configure({ hosts: [HOST], platform: Platform.OS, fetch: deadServer, timeoutMs: 3000 });
  const started = Date.now();
  expectResult('network error', await offline.resolve(`https://${HOST}/spring`), 'failed network_error');
  check('network error is quick', Date.now() - started < 3500, `${Date.now() - started} ms`);
  const slow = new Click2Sdk();
  slow.configure({
    hosts: [HOST],
    platform: Platform.OS,
    timeoutMs: 300,
    fetch: (_i, init) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
  });
  expectResult('timeout', await slow.resolve(`https://${HOST}/spring`), 'failed network_error');

  // Consent: nothing is recorded once tracking is off.
  await Click2.setTrackingEnabled(false);
  check('tracking off: no event', (await Click2.track('purchase')) === false);
  await Click2.setTrackingEnabled(true);
  check('tracking back on', await Click2.isTrackingEnabled());
}

export default function App() {
  const [checks, setChecks] = useState<Check[]>([]);
  const [opened, setOpened] = useState<string>('—');
  const [done, setDone] = useState<string>('running…');

  useEffect(() => {
    const results: Check[] = [];
    runSelfTest((c) => {
      results.push(c);
      console.log(`C2TEST ${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
      setChecks([...results]);
    })
      .catch((e) => {
        results.push({ name: 'crashed', ok: false, detail: String(e?.stack ?? e) });
        console.log(`C2TEST FAIL crashed — ${String(e?.stack ?? e)}`);
      })
      .finally(() => {
        const passed = results.filter((c) => c.ok).length;
        console.log(`C2TEST DONE ${passed}/${results.length}`);
        setDone(`${passed}/${results.length} passed`);
        setChecks([...results]);
        // After the self-test: handle links that open the app, like a real app would.
        const open = async (url: string | null | undefined) => {
          if (!url) return;
          const r = await Click2.resolve(url);
          console.log(`C2LINK ${url} → ${describe(r)}`);
          setOpened(`${url} → ${describe(r)}`);
        };
        Linking.getInitialURL().then(open);
        Linking.addEventListener('url', ({ url }) => open(url));
      });
  }, []);

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.pad}>
        <Text style={styles.h1}>click2 SDK self-test</Text>
        <Text testID="summary" style={styles.summary}>{done}</Text>
        <Text style={styles.label}>Opened by link</Text>
        <Text testID="opened">{opened}</Text>
        {checks.map((c) => (
          <Text key={c.name} style={c.ok ? styles.ok : styles.fail}>
            {c.ok ? '✓' : '✗'} {c.name}{c.ok || !c.detail ? '' : ` — ${c.detail}`}
          </Text>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  pad: { padding: 16, gap: 4 },
  h1: { fontSize: 20, fontWeight: '600', color: '#111' },
  summary: { fontSize: 16, marginBottom: 8, color: '#111' },
  label: { fontWeight: '600', marginTop: 8, color: '#111' },
  ok: { color: '#137333' },
  fail: { color: '#b3261e' },
});
