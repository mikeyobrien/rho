# Android Release Runbook

This document describes the process and CI pipeline for building and releasing the Rho Capacitor Android app.

## CI Pipeline Overview

The Android release pipeline is automated via GitHub Actions (`.github/workflows/android-release.yml`).
It is triggered on:
- Manual dispatch (`workflow_dispatch`)
- Pushing a version tag (e.g., `v1.2.3`)

### Release Gates
The pipeline enforces the following gates before building the artifact:
1. **Versioning Checks**: Enforced via tag requirements and package alignment.
2. **Artifact Verification**: Validates the output `app-release.aab` exists and computes its SHA256 checksum.
3. **Parity Gate**: Executes `npm run -s parity:gate` to ensure cross-platform compatibility metrics are met.
4. **Policy Checklist Tasks**: (Implemented as part of PR reviews and pre-tag audits).

## Required GitHub Secrets

To successfully build a signed AAB for Google Play Store distribution, the repository must have the following secrets configured in GitHub Actions:

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
  cd mobile/rho-android/android && ./gradlew bundleRelease
  ```
- [ ] Trigger a manual workflow run on GitHub to verify the CI process completes without errors.
- [ ] Download the generated `app-release.aab` from the GitHub Actions artifact and test it on a device using bundletool.
