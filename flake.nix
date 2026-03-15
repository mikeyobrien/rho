{
  description = "rho dev shell with Java + Android SDK for Capacitor builds";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      nixpkgs,
      flake-utils,
      ...
    }:
    flake-utils.lib.eachSystem [
      "x86_64-linux"
      "aarch64-linux"
    ] (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
          config = {
            allowUnfree = true;
            android_sdk.accept_license = true;
          };
        };

        jdk = pkgs.jdk17;
        node = pkgs.nodejs_22;
        emulatorSupported = pkgs.stdenv.hostPlatform.isx86_64;
        androidPlatformVersion = "35";
        androidBuildToolsVersion = "35.0.0";
        androidSystemImageType = "google_apis";
        androidEmulatorAbi = "x86_64";

        androidComposition = pkgs.androidenv.composeAndroidPackages {
          platformVersions = [ androidPlatformVersion ];
          buildToolsVersions = [ androidBuildToolsVersion ];
          abiVersions =
            if emulatorSupported then
              [ androidEmulatorAbi ]
            else
              [ "arm64-v8a" ];
          includeEmulator = emulatorSupported;
          includeNDK = false;
          includeSystemImages = emulatorSupported;
          includeSources = false;
          systemImageTypes = [ androidSystemImageType ];
          useGoogleAPIs = emulatorSupported;
          extraLicenses = [
            "android-sdk-preview-license"
            "android-googletv-license"
            "android-sdk-arm-dbt-license"
            "google-gdk-license"
            "intel-android-extra-license"
            "intel-android-sysimage-license"
            "mips-android-sysimage-license"
          ];
        };

        androidSdk = androidComposition.androidsdk;
      in
      {
        devShells.default = pkgs.mkShell {
          packages = [
            node
            jdk
            pkgs.gradle
            pkgs.git
            androidSdk
          ] ++ pkgs.lib.optionals emulatorSupported [ pkgs.steam-run ];

          shellHook = ''
            # Java
            export JAVA_HOME=${jdk}/lib/openjdk
            export PATH="$JAVA_HOME/bin:$PATH"

            # Android SDK (path differs slightly across Android SDK derivations)
            ANDROID_SDK_CANDIDATE="${androidSdk}/libexec/android-sdk"
            if [ -d "$ANDROID_SDK_CANDIDATE" ]; then
              export ANDROID_SDK_ROOT="$ANDROID_SDK_CANDIDATE"
            else
              export ANDROID_SDK_ROOT="${androidSdk}"
            fi
            export ANDROID_HOME="$ANDROID_SDK_ROOT"
            export PATH="$ANDROID_SDK_ROOT/emulator:$ANDROID_SDK_ROOT/platform-tools:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$PATH"

            # Keep generated state local to repo
            export GRADLE_USER_HOME="$PWD/.gradle"
            export ANDROID_USER_HOME="$PWD/.android"
            export ANDROID_AVD_HOME="$ANDROID_USER_HOME/avd"
            mkdir -p "$GRADLE_USER_HOME" "$ANDROID_USER_HOME" "$ANDROID_AVD_HOME"

            # Prefer the SDK-provided aapt2 so Gradle doesn't try to fetch its own.
            AAPT2_OVERRIDE=$(echo "$ANDROID_SDK_ROOT/build-tools/"*"/aapt2" | awk '{print $1}')
            export GRADLE_OPTS="-Dorg.gradle.project.android.aapt2FromMavenOverride=$AAPT2_OVERRIDE''${GRADLE_OPTS:+ $GRADLE_OPTS}"

            echo "[rho] nix dev shell ready"
            echo "  JAVA_HOME=$JAVA_HOME"
            echo "  ANDROID_SDK_ROOT=$ANDROID_SDK_ROOT"
            echo "  ANDROID_AVD_HOME=$ANDROID_AVD_HOME"
            if [ "${if emulatorSupported then "1" else "0"}" = "1" ]; then
              echo "  Emulator support: enabled (${androidSystemImageType}/${androidEmulatorAbi})"
              echo "  Create AVD: avdmanager create avd -n rho-api${androidPlatformVersion} -k 'system-images;android-${androidPlatformVersion};${androidSystemImageType};${androidEmulatorAbi}'"
              echo "  Start AVD: steam-run emulator -avd rho-api${androidPlatformVersion}"
            else
              echo "  Emulator support: disabled on this host architecture (build shell only)"
            fi
          '';
        };
      }
    );
}
