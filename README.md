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
  // readInstallReferrer: () => PlayInstallReferrer.getInstallReferrerInfo().then((i) => i.installReferrer),
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

Native setup is the same as for native apps: Associated Domains (`applinks:acme.click2.page`) on iOS and an
`autoVerify` intent filter on Android (see the click2 dashboard → Developers).

Status: 0.3.0, not published yet (needs the npm org). License: Apache 2.0.
