# Android store submission checklist

This is the repo-side checklist for getting `mobile/rho-android` onto Google Play and F-Droid.

## What the repo now covers

- Android release CI builds signed `apk` + `aab` assets on version tags.
- Android compile/target SDK are aligned with current Play requirements.
- Android `versionName` and `versionCode` derive from repo versioning.
- Mobile package version is gated against the root package version.
- Public HTTP profiles are blocked in the app; localhost/LAN/Tailscale-style HTTP remains explicit opt-in.
- Fastlane metadata skeleton exists under `mobile/rho-android/fastlane/metadata/android/`.
- Privacy policy source lives at `docs/rho-android-privacy-policy.md`.

## Still required before first store submission

### Store assets
- [ ] final launcher icon / feature graphic review
- [ ] phone screenshots
- [ ] tablet screenshots if tablet distribution is enabled
- [ ] final store copy review
- [ ] final privacy policy hosting URL (public, stable URL)

### Google Play manual work
- [ ] create / verify Play Console developer account
- [ ] create app listing
- [ ] upload release `aab`
- [ ] complete Data safety form
- [ ] provide privacy policy URL
- [ ] complete foreground service declaration for `dataSync`
- [ ] record a short demo video showing user-initiated Live Mode use
- [ ] start with internal or closed testing

### F-Droid manual work
- [ ] verify clean source build from public repo without private signing material
- [ ] add screenshots/graphics compatible with F-Droid listing expectations
- [ ] prepare `fdroiddata` recipe or packaging request
- [ ] disclose any anti-features if policy ever requires it
- [ ] expect separate signing/update channel from Play unless reproducible upstream-signed flow is adopted

## Release commands

```bash
npm test
npm run -s parity:gate
npm run -s mobile:test
npm run -s mobile:build
npm run -s mobile:sync
cd mobile/rho-android/android && ./gradlew bundleRelease assembleRelease
```

## Notes for reviewers / policy forms

### Foreground service justification
`rho-android` uses a `dataSync` foreground service only when the user explicitly enables **Live Mode**. Its purpose is to keep an active rho session alive while the device is backgrounded or locked. The notification is persistent, user-visible, and user-stoppable.

### Network model
The app is designed for self-hosted rho servers. HTTPS is the expected mode for remote/public deployments. HTTP is retained only for localhost, trusted LAN, and Tailscale/private-network scenarios you control; public HTTP profiles are blocked.

### Suggested launch order
1. Ship GitHub release assets.
2. Run Play internal test.
3. Submit to Play production.
4. Submit to F-Droid after the Play path is stable.
