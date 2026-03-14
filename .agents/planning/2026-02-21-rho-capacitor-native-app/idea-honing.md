# Idea Honing

Requirements clarification Q&A will be captured here.

## Q1

**Question:** For the first version, should the Capacitor app connect to a **local on-device rho web server** (bundled/sidecar) or to a **remote rho server** over the network?

**Answer:** Both connection modes should be supported (local on-device + remote over network).

## Q2

**Question:** For first launch in v1, which mode should be the default: **local** or **remote**?

**Answer:** Treat all connections as host+port to a remote endpoint. “Local” is just a remote target set to localhost (same connection model).

## Q3

**Question:** What auth mechanism should v1 require for connecting to a rho server: **API token only**, **username/password login**, or **both**?

**Answer:** API token only (KISS).

## Q4

**Question:** Should the app enforce HTTPS/TLS for non-localhost hosts in v1 (i.e., block plain HTTP except `localhost` / private-dev overrides)?

**Answer:** No strict enforcement in v1; user is responsible for their security posture.

## Q5

**Question:** For API token storage on device, should v1 require **native secure storage** (Keychain/Keystore via Capacitor secure plugin), or is plain app storage acceptable?

**Answer:** Require native secure storage, using the platform standard on Android/iOS (Keystore/Keychain via Capacitor-compatible secure storage).

## Q6

**Question:** In v1, do you want support for **multiple saved server profiles** (e.g., local + staging + prod) with quick switching, or just a single connection config?

**Answer:** Multiple saved profiles with quick switching.

## Q7

**Question:** Should each profile support **separate token per profile** (recommended), or one global token shared across profiles?

**Answer:** Each profile should have its own token. Assumption: token issuance/provisioning comes from the target rho server.

## Q8

**Question:** For v1 token provisioning, should users **manually paste a token** into each profile, or should the app implement a **server-driven token mint/login flow**?

**Answer:** Manual token paste per profile (simplest for v1).

## Q9

**Question:** Platform scope for v1: should we target **iOS + Android both**, or one platform first?

**Answer:** Android first for v1.

## Q10

**Question:** For network trust in Android v1, do you want to support **self-signed/private certs** (via custom trust/pinning strategy), or keep it simple and rely on standard OS trust only?

**Answer:** Standard OS trust only for v1 (safe enough when using valid HTTPS certs).

## Q11

**Question:** Should v1 be a **thin wrapper** (native settings/profile screen + embedded existing rho web UI), or do you want significant native UI parity in the app shell?

**Answer:** Thin wrapper for v1.

## Q12

**Question:** Should the app include an explicit **connection test** action per profile (ping/health check) before opening the embedded UI?

**Answer:** No explicit connection-test action in v1.

## Q13

**Question:** Should Android v1 allow connecting to **plain HTTP** endpoints (not just HTTPS), e.g. for localhost/LAN dev servers?

**Answer:** Yes, allow plain HTTP in v1.

## Q14

**Question:** For profile data model, what minimum fields do you want: `name`, `scheme` (http/https), `host`, `port`, `token` — plus anything else (e.g. path prefix)?

**Answer:** Start with only `name`, `scheme`, `host`, `port`, and `token`.

## Q15

**Question:** How should the token be sent on requests in v1: standard `Authorization: Bearer <token>` header (recommended), or a custom header expected by rho-web?

**Answer:** Use standard `Authorization: Bearer <token>`.

## Q16

**Question:** Security boundary choice for v1: should the token stay **native-only** (never exposed to web JS; native bridge/proxy injects auth), or is it acceptable for token to be available to the web layer?

**Answer:** Native-only token handling; token must not be exposed to web JS.

## Q17

**Question:** On app startup, should users land on a **profile picker screen** first, or auto-open the **last used profile** and only show picker when none exists?

**Answer:** Auto-open last used profile; show profile picker only when none exists or user explicitly switches.

## Q18

**Question:** Do you want an in-app control to **switch profile** while using rho UI (e.g., menu action that returns to profile picker)?

**Answer:** Yes, provide an in-app profile switch control.

## Q19

**Question:** For Android v1 distribution, do you want to optimize for **debug sideload/internal use** first, or package/release readiness (signing, release build pipeline) immediately?

**Answer:** Release-ready packaging from the start (signing + release build pipeline).

## Q20

**Question:** For keeping the API token native-only, are you okay adding a small rho-web server auth endpoint for mobile (token exchange to short-lived HttpOnly session), so the web UI can run without direct token access?

**Answer:** Yes.

## Q21

**Question:** Session behavior for v1: after successful token exchange, should the mobile session persist across app restarts until logout/profile change, or should users re-authenticate every app launch?

**Answer:** Persist across app restarts until logout/profile change.

## Q22

**Question:** Any hard constraints for this first delivery (deadline, max scope, or must-have acceptance criteria beyond “installable + secure profile/token flow”)?

**Answer:** Must maintain feature parity with current rho web behavior and avoid regressions.

## Q23

**Question:** For “feature parity,” should Android v1 support **all existing rho-web routes/features** exactly, with only minimal mobile shell additions (profiles/auth/session)?

**Answer:** Yes — full rho-web route/feature parity, with only minimal mobile shell additions for profiles/auth/session.

## Q24

**Question:** On auth/session failure (401/expired session), should the app automatically return to profile selection and prompt re-auth for that profile?

**Answer:** Yes, automatically return to profile selection and prompt re-auth for that profile.

## Q25

**Question:** Do you consider requirements clarification complete, or do you want to refine anything else before we move to research planning?

**Answer:** Requirements clarification is complete.

## Connections

- [[rough-idea.md]]
