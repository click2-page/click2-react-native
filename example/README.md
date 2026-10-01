# click2 React Native example and self-test

A bare React Native app (Hermes) that runs the SDK on a real Android emulator or device: link resolution, A/B
variants, AsyncStorage persistence, in-app events with revenue, deferred links from the Play install referrer
(simulated), pasted links (iOS flow), network errors and timeouts, consent, and links that open the app (cold start
and while running). Results show on screen and in `adb logcat -s ReactNativeJS` as `C2TEST PASS|FAIL <name>`.

The app's link host is `acme.click2.page`; every request goes to `http://localhost:8799` instead (forwarded to the
device with `adb reverse`), so it runs against a local click2 server with a team `acme` and these links:

| Alias | Destinations |
|---|---|
| `spring` | `deeplinkPath: product/42`, `webUrl: https://www.example.com/spring`, campaign `spring-sale`, channel `email` |
| `webonly` | `webUrl: https://www.example.com/terms`, `webOnly: true` |
| `droid` | `androidDeeplinkPath: android/home`, `iosDeeplinkPath: ios/home` |
| `ab` | `deeplinkPath: control`, split `a` (50, control) / `b` (50, `deeplinkPath: variant-b`) |

Run (JDK 17, Android SDK, an emulator or device connected):

```bash
ANDROID_SERIAL=emulator-5554 ./selftest-android.sh
```

iOS needs CocoaPods (`cd ios && pod install`, then `npx react-native run-ios`); the pasted-link flow is covered on
Android with `platform: "ios"`.
