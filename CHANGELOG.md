# Changelog

All notable changes to the click2 React Native SDK. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/). While the version is 0.x, minor versions may contain breaking changes; they are called out here.

## [Unreleased]

## [0.3.0] - 2026-10-01

First release, on par with the iOS and Android SDKs 0.3.0. Pure TypeScript, no native code of its own; works on
Hermes.

- `Click2.resolve(url)`: what a click2 link opens (in-app route, web page, or why it failed), only for the team's hosts.
- Deferred deep links: the Play install referrer on Android (`checkDeferredLink`, with `readInstallReferrer` and
  `firstInstallTime`), a pasted link on iOS (`handleDeferredLink`); the install is reported once.
- In-app events and revenue: `Click2.track(name, { revenue, currency, properties })`, credited to the link that last
  opened the app within `attributionWindowMs` (default 7 days), A/B variant included.
- `setUserId`, `setTrackingEnabled` (consent), `markInstallReported`, `markDeferredLinkChecked`.
- Helpers: `linkHost`, `linkInText`, `linkFromReferrer`, `mapResolve`.

[Unreleased]: https://github.com/click2-page/click2-react-native/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/click2-page/click2-react-native/releases/tag/v0.3.0
