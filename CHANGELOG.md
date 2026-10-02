# Changelog

All notable changes to the click2 React Native SDK. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/). While the version is 0.x, minor versions may contain breaking changes; they are called out here.

## [Unreleased]

## [0.3.2] - 2026-10-02

### Changed

- Campaign install reports (Play install referrer without a click2 link) now send up to 4,000 characters of the
  referrer instead of 1,000. Meta ads referrers carry encrypted JSON in `utm_content` and are often longer than 1,000
  characters; a truncated one can't be decrypted by the server.

### Tests

- Shared fixture `campaign-referrer.json`: a Meta ads install referrer case (reported as a campaign install).

### Docs

- NOTICE names the React Native SDK; README points to Apps & SDKs in the click2 dashboard.

## [0.3.1] - 2026-10-02

### Fixed

- Organic Play installs (`utm_source=google-play&utm_medium=organic`, or google-play with no other campaign keys) and
  click2 referrers whose link is for another host are no longer reported as campaign installs. Campaign keys are
  matched as parameter names with a value (`utm_*`, `gclid`, `gbraid`, `wbraid`); new helper `isCampaignReferrer`.
- Install reports answered with HTTP 408 or 429 are retried later instead of being treated as final.
- Android deferred links: a referrer link that couldn't be resolved (offline, 5xx) is kept with an attempt count and
  tried again on later launches (up to 5, within `deferredLinkMaxAgeMs`), and an install report without a final answer
  is sent again, like the Android SDK. `checkDeferredLink` runs once per launch.
- **Behaviour change:** on Android the install referrer is only used when `firstInstallTime` is provided (a warning is
  logged once otherwise), so an app update shipping the SDK can't replay an old referrer as a new install. The README
  sample now includes it.
- `configure` validates and normalizes `hosts` once (trimmed, lowercased, trailing dot removed, duplicates dropped)
  and that list is used everywhere, so `track()` attribution works when hosts were given with capitals or a trailing
  dot. Anything but a bare host name now throws.
- A failed request is no longer retried: `fetch` doesn't say whether it reached the server, and a repeated resolve
  could count the open twice.
- Link matching decodes the whole path before splitting it, like the native SDKs: `/api%2Fx` is a service path, not a
  link (new shared fixture case; new shared `campaign-referrer.json`).
- Release workflow: npm is pinned (11.6.2) instead of `npm@latest`.

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

[Unreleased]: https://github.com/click2-page/click2-react-native/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/click2-page/click2-react-native/releases/tag/v0.3.2
[0.3.1]: https://github.com/click2-page/click2-react-native/releases/tag/v0.3.1
[0.3.0]: https://github.com/click2-page/click2-react-native/releases/tag/v0.3.0
