# Android Release Runbook

This document describes the process and CI pipeline for building and releasing the Rho Capacitor Android app.

Tag-triggered releases publish four assets to the GitHub Release page:
- `rho-<tag>.apk`
- `rho-<tag>.apk.sha256`
- `rho-<tag>.aab`
- `rho-<tag>.aab.sha256`

## CI Pipeline Overview

The Android release pipeline is automated via GitHub Actions (`.github/workflows/android-release.yml`).
It is triggered on:
- Manual dispatch (`workflow_dispatch`)
- Pushing a version tag (e.g., `v1.2.3`)

### Release Gates
The pipeline enforces the following gates before building the artifact:
1. **Versioning Checks**: Enforced via tag requirements and package alignment.
2. **Artifact Verification**: Validates both `app-release.aab` and `app-release.apk`, then computes SHA256 checksums for each.
3. **Parity Gate**: Executes `npm run -s parity:gate` to ensure cross-platform compatibility metrics are met.
4. **Policy Checklist Tasks**: Requires the dry-run checklist to remain in this runbook and manual acknowledgement for workflow dispatches.
5. **Release Asset Publishing**: Publishes the signed APK/AAB plus checksum files to the GitHub Release page for tag builds.

## Required GitHub Secrets

To successfully build signed Android release artifacts, the repository must have the following secrets configured in GitHub Actions:

- `ANDROID_KEYSTORE_BASE64`: The base64-encoded string of the release keystore `.jks` file.
  *(Generate via: `base64 -i my-release-key.jks > encoded.txt`)*
- `ANDROID_KEYSTORE_PASSWORD`: The password for the keystore.
- `ANDROID_KEY_ALIAS`: The alias of the key within the keystore.
- `ANDROID_KEY_PASSWORD`: The password for the specific key alias.

*Note: If these secrets are missing, the pipeline will fail immediately.*

## Dry-Run Checklist

Before creating a release tag or deploying to production, verify the following:

- [ ] Ensure all tests pass (`npm test`).
- [ ] Ensure the parity gate passes locally (`npm run parity:gate`).
- [ ] Verify `package.json` and Android app versions (`versionCode`, `versionName`) match the intended release.
- [ ] Run a local build to ensure compiling works:
  ```bash
  npm run -s mobile:build
  npm run -s mobile:sync
  cd mobile/rho-android/android && ./gradlew bundleRelease assembleRelease
  ```
- [ ] Trigger a manual workflow run on GitHub to verify the CI process completes without errors.
- [ ] Confirm the tag build created a GitHub Release and uploaded all four assets (APK, AAB, and both `.sha256` files).
- [ ] Download the generated `rho-<tag>.apk` and verify install/smoke test on a device or emulator.
- [ ] Optionally validate the AAB with bundletool if Play Store distribution is in scope.
