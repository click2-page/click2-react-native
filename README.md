# click2 for React Native

Deep links for React Native apps on [click2](https://click2.page): Universal Links / App Links, deferred deep links,
in-app events and revenue. Pure TypeScript (no native module of its own); behaves like the iOS and Android SDKs (it
passes the same shared test fixtures).

```sh
npm install @click2/react-native @react-native-async-storage/async-storage
# Android deferred links (optional): npm install react-native-play-install-referrer
```

```ts
import { Linking, Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Click2 } from "@click2/react-native";

Click2.configure({
  hosts: ["acme.click2.page"],            // staging builds: ["acme-test.click2.page"]
  platform: Platform.OS,
  appVersion: "7.2.0",
  storage: AsyncStorage,
  // Android deferred links (react-native-play-install-referrer takes a callback):
  // readInstallReferrer: () => new Promise((resolve) => PlayInstallReferrer.getInstallReferrerInfo((info, error) => resolve(error ? undefined : info?.installReferrer))),
  // firstInstallTime: () => DeviceInfo.getFirstInstallTime(),   // react-native-device-info
});

const route = (r) => {
  if (r.kind === "openRoute") navigation.navigate(/* map r.path to a screen */);
  else if (r.kind === "openWeb") Linking.openURL(r.url);
};
Linking.addEventListener("url", async ({ url }) => Click2.isClick2Link(url) && route(await Click2.resolve(url)));
Linking.getInitialURL().then(async (url) => url && Click2.isClick2Link(url) && route(await Click2.resolve(url)));

// Deferred deep link: Android install referrer (first launch), or a pasted link on iOS
const deferred = await Click2.checkDeferredLink();          // Android
// const deferred = await Click2.handleDeferredLink(await Clipboard.getString());   // iOS, after the user pastes

await Click2.setUserId(user.id);
await Click2.track("purchase", { revenue: 24.99, currency: "USD", properties: { sku: "A1" } });
await Click2.setTrackingEnabled(false);   // consent
```

`storage` is required for deferred links and install reports (otherwise every cold start would count again). Apps
that handled deferred links or installs themselves before: `Click2.markDeferredLinkChecked()` /
`Click2.markInstallReported()` at launch. Not in this SDK yet: Apple Search Ads attribution (needs a native module;
use the iOS SDK's `reportAppleSearchAdsAttribution` from a native wrapper). Uses no `URL`/`URLSearchParams` (React
Native's built-ins are incomplete).

Native setup is the same as for native apps: Associated Domains (`applinks:acme.click2.page`) on iOS and an
`autoVerify` intent filter on Android (see the click2 dashboard → Developers).

Example app with an on-device self-test (Android, Hermes release build): [example/](example/).

Releasing: set `version` in package.json and the SDK header in `src/index.ts`, move the CHANGELOG entries under the
new version, push, then tag `vX.Y.Z`; the release workflow publishes to npm (trusted publishing, with provenance) and
creates the GitHub Release. License: Apache 2.0.
