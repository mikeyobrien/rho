# rho Android privacy policy

_Last updated: 2026-03-14_

`rho-android` is a native Android wrapper for the rho web workspace.

## Summary

- We do **not** run a hosted rho memory backend for this app.
- Your rho memory, config, and session state are intended to stay on infrastructure you control.
- The Android app connects to the rho server profile you choose.
- If you provide a bearer token for a profile, the app stores it in device storage intended for secrets.
- The app may keep an active foreground service notification while Live Mode is enabled.

## Data the app can process

Depending on how you use rho, the app may process:

- connection profile details you enter manually (name, host, port, scheme)
- authentication tokens you choose to save for a profile
- cookie-based session state issued by your rho server
- chat/session content rendered from your rho server
- task, memory, config, and review data returned by your rho server
- Live Mode lease context needed to keep an active mobile session alive in the background

## Where data goes

The app sends data only to the rho server endpoint you configure.

Typical destinations are:
- `localhost` during development
- a LAN/Tailscale/private host you control
- an HTTPS endpoint you operate

The app does not include Firebase, Google Analytics, ad SDKs, or third-party mobile tracking SDKs in the Android wrapper at this time.

## Authentication

If your rho server has auth enabled, the app can exchange a saved bearer token for a cookie-backed web session with that server.

If auth is disabled on the target server, the app may connect without token exchange.

## Foreground service / notifications

When you enable **Live Mode**, the app starts an Android foreground service with a persistent notification so an active response can continue while the phone is locked or backgrounded.

Live Mode is:
- explicitly user controlled (`Go Live` / `Stop Live`)
- visible through a persistent notification
- intended only for active session continuity
- not used for location, camera, microphone, or advertising purposes

## Data sharing

The Android wrapper does not sell personal data.

The app only shares data with the rho server you configured and the network providers required to reach that server.

## Security notes

- HTTPS is recommended for remote/public deployments.
- Public HTTP profiles are blocked in the mobile shell.
- Localhost and LAN HTTP connections are allowed only as explicit user choices for development or self-hosted local setups.

## Contact

Project: https://github.com/mikeyobrien/rho
Contact: tidepool@rhobot.dev
