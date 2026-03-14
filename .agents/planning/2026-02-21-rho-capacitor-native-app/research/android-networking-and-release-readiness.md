# Android Networking and Release Readiness

## Scope

Document Android-specific constraints for:
- HTTP/HTTPS connection behavior,
- trust model,
- Capacitor runtime/network policy,
- release-ready packaging/signing pipeline.

## Networking decisions from requirements

From clarification:
- Android-first.
- Standard OS trust only.
- Allow plain HTTP in v1.
- User controls security posture.

This is feasible, but requires explicit guardrails to avoid accidental insecure defaults.

## Cleartext (HTTP) strategy

### Recommended split

- **Release default:** HTTPS-first in UX; explicit warning when profile uses HTTP.
- **Android config:** use `network_security_config.xml` to control cleartext allowances deliberately.
- If arbitrary user-defined HTTP hosts must be supported, cleartext allowance may become broad (higher risk) unless constrained by profile policy + UX warnings.

```mermaid
flowchart TD
  A[Profile scheme] --> B{https?}
  B -->|Yes| C[Use standard OS trust]
  B -->|No (http)| D[Require explicit user confirmation]
  D --> E[Proceed with cleartext warning badge]
  E --> F[Allow request per app network config]
```

## Key risk notes

1. **Android blocks cleartext by default on modern targets**
   - explicit config needed for HTTP.

2. **Capacitor remote-navigation settings are sensitive**
   - `server.url`, `allowNavigation`, and cleartext settings are not intended as broad production bypasses.

3. **Mixed trust posture can confuse users**
   - if HTTP and HTTPS both supported, UI must clearly indicate active security mode per profile.

## Release-ready Android checklist (v1)

1. Establish signing strategy now (upload key + Play App Signing).
2. Build signed AAB in CI.
3. Keep target SDK/Capacitor versions aligned.
4. Add policy checks early (target API, permissions declarations, app content forms).
5. Add smoke run for:
   - profile create/edit/switch,
   - auth exchange,
   - session resume,
   - auth failure recovery.

```mermaid
flowchart LR
  A[Web build + tests] --> B[Capacitor sync]
  B --> C[Android release build AAB]
  C --> D[Signing + artifact checks]
  D --> E[Policy/prelaunch checks]
  E --> F[Internal track rollout]
  F --> G[Production rollout]
```

## Potential release surprises

- Play review flags if networking security posture appears too permissive.
- CI drift between Node/JDK/Gradle/Capacitor causes unstable release builds.
- Cleartext support can trigger additional review scrutiny.
- Third-party network dependencies (CDNs used by web UI) can reduce reliability in constrained/mobile environments.

## Sources

- https://capacitorjs.com/docs/config
- https://capacitorjs.com/docs/guides/live-reload
- https://developer.android.com/privacy-and-security/security-config
- https://developer.android.com/privacy-and-security/risks/cleartext-communications
- https://developer.android.com/guide/topics/manifest/application-element
- https://capacitorjs.com/docs/cli/commands/build
- https://developer.android.com/studio/publish/app-signing
- https://developer.android.com/studio/publish/upload-bundle

## Connections

- [[../idea-honing.md]]
- [[rho-web-baseline-and-gaps.md]]
- [[capacitor-security-and-session-patterns.md]]
- [[risk-register-and-mitigation-plan.md]]
- [[_index]]
- [[openclaw-runtime-visibility-inspiration]]
