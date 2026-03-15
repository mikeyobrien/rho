# Nix dev shell for Android (Capacitor)

This repo includes a `flake.nix` that provides a reproducible shell with:

- JDK 17
- Node 22
- Gradle
- Android SDK platform 35 + build-tools 35.0.0
- Android platform-tools + command-line tools
- on `x86_64-linux`, Android emulator + Google APIs system image support

## Usage

```bash
nix develop
```

Inside the shell, verify toolchain:

```bash
echo "$JAVA_HOME"
echo "$ANDROID_SDK_ROOT"
echo "$ANDROID_AVD_HOME"
java -version
```

## Build flow

```bash
npm run -s mobile:build
npm run -s mobile:sync
cd mobile/rho-android/android
./gradlew assembleDebug
```

## Emulator flow (`x86_64-linux`)

The shell now exposes:

- `ANDROID_SDK_ROOT`
- `ANDROID_HOME`
- `ANDROID_USER_HOME=$PWD/.android`
- `ANDROID_AVD_HOME=$PWD/.android/avd`
- `emulator`, `adb`, `sdkmanager`, and `avdmanager` on `PATH`

Create an AVD:

```bash
avdmanager create avd \
  -n rho-api35 \
  -k "system-images;android-35;google_apis;x86_64"
```

List AVDs:

```bash
emulator -list-avds
```

Start the emulator:

```bash
steam-run emulator -avd rho-api35
```

Why `steam-run`? On NixOS/Linux, the Android emulator often expects FHS-style runtime libraries (for example X11/GL-related libs). `steam-run` is the low-friction wrapper recommended by the NixOS Android wiki when launching SDK-provided emulator images directly.

If raw `emulator -avd rho-api35` works on your host, use it. If it fails with missing shared libraries, use `steam-run`.

Wait for boot:

```bash
adb wait-for-device
while [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" != "1" ]; do
  sleep 1
done
adb shell input keyevent 82
```

Install and smoke an APK:

```bash
adb install -r mobile/rho-android/android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -W -n dev.rhobot.rhoandroid/dev.rhobot.rhoandroid.MainActivity
```

## Linux host requirements

For usable emulator performance, make sure:

- CPU virtualization is enabled in firmware/BIOS
- `/dev/kvm` exists
- your user can access KVM (typically membership in the `kvm` group)

Quick checks:

```bash
ls -l /dev/kvm
id | tr ' ' '\n' | grep kvm || true
```

Without KVM, the emulator may still boot, but it will usually be much slower.

## Notes

- Android licenses are accepted via flake nixpkgs config (`android_sdk.accept_license = true`).
- Extra Google/emulator licenses are included for the Google APIs system image flow.
- Generated Gradle/Android user state is kept local to the repo (`.gradle/`, `.android/`).
- On non-`x86_64-linux` hosts, the shell remains usable for Android builds, but emulator support is intentionally disabled.
