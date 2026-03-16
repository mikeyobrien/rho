# Store Assets Requirements

## Screenshots

### Play Store Requirements
- **Phone screenshots**: 2-8 images, 1080x1920 (9:16), PNG or JPEG
- **7" tablet**: 2-8 images, 1200x1920
- **10" tablet**: 2-8 images, 2560x1600
- **Feature graphic**: 1024x500, PNG or JPEG
- **App icon**: 512x512 (PNG, 32-bit)

### F-Droid Requirements
- **Screenshots**: At least 2, any reasonable size (typically 1080x1920)
- No feature graphic needed

## Suggested Screenshots to Capture

1. **01-login** - Connect/server URL screen
2. **02-sessions** - Session list/workspace view
3. **03-terminal** - Terminal interface
4. **04-tasks** - Task management screen
5. **05-settings** - Settings/configuration

## Current Status

- [ ] Directory created: `fastlane/screenshots/en-US/`
- [ ] Phone screenshots (1080x1920): Needed
- [ ] Feature graphic (1024x500): Needed
- [ ] App icon (512x512): Needed

## Notes

- rho-android wraps rho-web in a native shell
- Screenshots can be captured via:
  - Android emulator: `adb shell screencap /sdcard/screenshot.png`
  - Android device: Volume-down + power button
  - Android Studio: Device Manager > Capture screenshot
