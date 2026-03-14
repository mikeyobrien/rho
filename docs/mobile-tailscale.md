# rho mobile app over Tailscale

Use this setup when you want the Android rho mobile app to talk to a rho-web server on a home machine, VPS, or another device in your Tailscale tailnet without exposing rho to the public internet.

```text
Android rho app --Tailscale--> rho web server
```

This is the cleanest remote setup for rho mobile right now.

## What you get

- private access to rho-web from your phone
- no public port forwarding required
- optional app-level auth on top of Tailscale
- working Live Mode over the tailnet when you want background continuity

## Recommended topology

- **Server**: runs `rho web`
- **Phone**: runs the Android rho mobile app
- **Network**: both devices signed into the same Tailscale tailnet
- **Addressing**: connect with either:
  - the server's Tailscale IP (`100.x.y.z`)
  - the server's MagicDNS name (if enabled)

## Prerequisites

On the server:
- rho installed and working
- Tailscale installed and connected

On Android:
- rho mobile app installed
- Tailscale app installed and connected

Optional:
- rho mobile auth token configured if you want rho's own app auth in addition to Tailscale

## 1. Start rho-web on the server

On the machine that will host rho:

```bash
rho web
```

By default rho-web listens on port `3141` and binds to `0.0.0.0`, so it is reachable from your Tailscale interface as long as the machine is online and Tailscale is connected.

If you want a different port:

```bash
rho web --port 4000
```

You can also enable web in `~/.rho/init.toml` and let `rho start` manage it, but `rho web` is the simplest way to verify the setup.

### Quick server sanity checks

On the server:

```bash
tailscale ip -4
rho status
```

From another device on the same tailnet, confirm the web UI responds:

```bash
curl http://100.x.y.z:3141/api/health
```

Or open:

```text
http://100.x.y.z:3141
```

If you use MagicDNS, replace the IP with your device name, for example:

```text
http://rho-box.your-tailnet.ts.net:3141
```

## 2. Join both devices to Tailscale

1. Install Tailscale on the server and sign in.
2. Install Tailscale on your Android phone and sign in to the same tailnet.
3. Find the server's:
   - Tailscale IPv4 address, or
   - MagicDNS hostname

Useful commands on the server:

```bash
tailscale status
tailscale ip -4
```

## 3. Choose your auth mode

You have two workable options.

### Option A: Tailscale-only

Use this if your tailnet is already your trust boundary.

- leave rho mobile auth disabled on the server
- leave the token field blank in the Android app
- connect directly over Tailscale

This is the simplest setup.

### Option B: Tailscale + rho mobile auth

Use this if you want the app to present a token before rho-web grants API/WebSocket access.

Add this to `~/.rho/init.toml` on the server:

```toml
[settings.web]
auth_enabled = true
auth_token_hashes = ["<sha256 of your raw token>"]
auth_session_ttl_seconds = 900
```

Generate a token hash with Node:

```bash
node -e 'const crypto=require("node:crypto"); const token=process.argv[1]; console.log(crypto.createHash("sha256").update(token).digest("hex"))' "replace-with-your-token"
```

Then restart rho-web.

In the Android app, enter the **raw token** in the profile. The server stores only the SHA-256 hash in config.

### Which should you pick?

My take:
- **personal tailnet, only your own devices**: Tailscale-only is fine
- **shared tailnet, less trusted devices, or you just want another gate**: turn on rho mobile auth too

## 4. Add a profile in the Android app

In the rho mobile app, create a profile with:

- **Name**: anything descriptive, for example `Home Rho`
- **Scheme**:
  - `http` for a direct Tailscale connection in most setups
  - `https` only if you have actually put rho-web behind HTTPS
- **Host**:
  - Tailscale IP, like `100.101.102.103`, or
  - MagicDNS hostname, like `rho-box.your-tailnet.ts.net`
- **Port**: usually `3141`
- **Token**:
  - blank for Tailscale-only
  - raw token if `auth_enabled = true`

### Example profile

```text
Name:   Home Rho
Scheme: http
Host:   100.101.102.103
Port:   3141
Token:  [blank]
```

Example with app auth enabled:

```text
Name:   Home Rho
Scheme: http
Host:   rho-box.your-tailnet.ts.net
Port:   3141
Token:  your-raw-token
```

## 5. Connect

Tap the profile and launch it.

What happens:
- if no token is configured, the app opens the server directly
- if a token is configured, the app exchanges it for a cookie-backed session first
- for remote hosts, the app navigates top-level instead of trying to keep the remote site in a cross-host iframe; that avoids cookie and WebSocket weirdness

If the server is reachable, you should land in rho-web with the mobile shell flag enabled.

## 6. Live Mode over Tailscale

Live Mode works over Tailscale the same way it does on local networks:

- **Idle Mode**: better battery behavior; reconnects when the app returns active
- **Live Mode**: keeps an Android foreground service running with lease heartbeats so active streams are more likely to survive backgrounding/lock

Use **Live Mode** when stream continuity matters. Expect higher battery and network use while it is active.

## Tailscale-specific notes

### The app recognizes common Tailscale HTTP hosts

The Android app now treats these HTTP targets as private-network style connections instead of blocked public HTTP:

- Tailscale IPs in `100.64.0.0/10`
- `*.ts.net` MagicDNS names
- bare single-label hostnames like `tidepool` that are commonly used as MagicDNS-style names

You should still expect a confirmation warning, because the URL is still `http://`, but the app no longer treats these as public internet HTTP by default.

In practice:
- plain `http://` over the open internet is bad
- `http://` carried inside a Tailscale tailnet is usually a reasonable setup for personal rho access because Tailscale encrypts the transport between tailnet devices

### HTTPS is optional here

You do **not** need public HTTPS just to use rho mobile over Tailscale.

If you already run rho-web behind HTTPS, use it. If not, a direct Tailscale `http://100.x.y.z:3141` setup is the normal low-friction option.

## Troubleshooting

### The phone cannot connect

Check:
- Tailscale is connected on both devices
- the server is online
- `rho web` is running
- the host and port in the profile are correct
- you did not accidentally add a trailing slash to the API base anywhere

Server-side checks:

```bash
rho status
tailscale status
curl http://127.0.0.1:3141/api/health
curl http://$(tailscale ip -4 | head -n1):3141/api/health
```

### "Network unreachable"

Usually means one of:
- wrong host
- wrong port
- Tailscale disconnected
- server asleep/offline
- firewall/policy blocking access

Try the Tailscale IP first before MagicDNS to rule out hostname issues.

### "Invalid token"

If app auth is enabled:
- make sure the app profile contains the **raw** token
- make sure `auth_token_hashes` contains the SHA-256 hash of that exact raw token
- restart rho-web after changing config

### App auth keeps failing behind a public reverse proxy

If you are routing rho-web through a public domain with SSO or proxy auth in front of it, mobile auth exchange can get messy.

For the Android app, the clean path is:
- connect directly over Tailscale to the rho-web host, or
- make sure `/api/auth/*` is not being redirected away from rho-web

If you just want reliable mobile access, Tailscale is the better path.

### Web UI loads but API/WebSocket features fail

This usually means auth/session setup is wrong, or the app is reaching a different host than you think.

Check:
- token matches the configured hash
- `auth_enabled` is set the way you expect
- host in the app is the same host rho-web is actually serving
- reverse proxies are not rewriting or intercepting `/api/*` or `/ws`

### Live Mode stops unexpectedly

Check:
- Android notification permission is granted
- Tailscale stays connected while the phone is backgrounded
- the server remains reachable on the tailnet
- auth has not expired or been revoked

## Security recommendations

My recommendation is simple:

1. Prefer **Tailscale over public exposure** for rho mobile.
2. If your tailnet includes devices or users you do not fully trust, also enable rho mobile auth.
3. Only bother with public HTTPS/reverse proxy complexity if you actually need browser access outside Tailscale.

For most personal setups, this is enough:

```text
Tailscale + rho web + optional app auth
```

## Quick checklist

- [ ] `rho web` is running on the server
- [ ] server and phone are both on the same Tailscale tailnet
- [ ] profile host is the server's Tailscale IP or MagicDNS name
- [ ] profile port matches rho-web
- [ ] token is blank unless `auth_enabled = true`
- [ ] if auth is enabled, the app has the raw token and the server has the SHA-256 hash
- [ ] use Live Mode only when you actually need background continuity
