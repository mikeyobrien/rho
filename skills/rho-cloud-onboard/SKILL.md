---
name: rho-cloud-onboard
description: Register an agent email address on Rhobot Mail (name@rhobot.dev). Use when the user wants to set up agent email, register a Rhobot Mail account, claim an email handle, or onboard to rhobot.dev.
---

# Rhobot Mail Onboarding

Register an agent email address on Rhobot Mail and configure local credentials. The agent gets an inbox at `name@rhobot.dev` that can be polled via API.

## Parameters

- **handle** (required): The desired email local part (e.g. `tau` for `tau@rhobot.dev`)
- **display_name** (optional): Human-readable name for the agent

## URLs

- **Landing page**: `https://rhobot.dev/email`
- **Skill reference**: `https://rhobot.dev/skill.md`
- **API endpoint**: `https://api.rhobot.dev` (all API calls go here)

## Prerequisites

- `curl` and `jq` installed
- Internet access to `api.rhobot.dev`

## Steps

### 1. Collect Handle

Ask the user what email handle they want. If not provided, suggest one based on the agent's name or personality.

**Constraints:**
- Handle MUST be 1-64 characters, lowercase alphanumeric and hyphens only
- Handle MUST NOT start or end with a hyphen
- Handle MUST NOT be a reserved name: `admin`, `postmaster`, `abuse`, `noreply`, `no-reply`, `support`, `help`, `info`, `security`, `webmaster`, `hostmaster`, `mailer-daemon`, `root`, `dmarc`
- You MUST validate the handle format locally before making the API call
- You MUST confirm the handle with the user before registering: "Register as `{handle}@rhobot.dev`?"

### 2. Check Existing Credentials

Before registering, check if credentials already exist.

```bash
cat ~/.config/rho-cloud/credentials.json 2>/dev/null
```

**Constraints:**
- If credentials exist and contain a valid `api_key`, MUST warn the user: "Existing credentials found for `{email}`. Registering again will create a new account. Continue?"
- If the user does not confirm, MUST stop
- You MUST NOT overwrite credentials without explicit confirmation

### 3. Register with API

Call the registration endpoint.

```bash
curl -s -X POST https://api.rhobot.dev/v1/register \
  -H "Content-Type: application/json" \
  -d '{"name": "{handle}", "display_name": "{display_name}"}' | jq .
```

**Constraints:**
- You MUST check the response `ok` field before proceeding
- You MUST handle these error cases:

| HTTP Status | Error | Action |
|-------------|-------|--------|
| 400 | Invalid name format | Show the validation rules. Ask user to pick a different handle. Return to Step 1. |
| 409 | Handle already taken | Tell user `{handle}@rhobot.dev` is taken. Suggest alternatives: `{handle}-agent`, `{handle}-bot`, `{handle}-ai`, or ask user for another name. Return to Step 1. |
| 500 | Server error | Report the error. Suggest retrying in a few minutes. |
| Network error | Connection failed | Check internet. Suggest `curl -s https://api.rhobot.dev/v1/health | jq .` to verify the API is up. |

- You MUST NOT proceed if registration fails
- On 409 (taken), you MUST suggest at least 3 alternative handles

### 4. Save Credentials

On successful registration, save the credentials locally.

```bash
mkdir -p ~/.config/rho-cloud
cat > ~/.config/rho-cloud/credentials.json << 'EOF'
{
  "api_key": "{api_key from response}",
  "agent_id": "{agent_id from response}",
  "email": "{email from response}"
}
EOF
chmod 600 ~/.config/rho-cloud/credentials.json
```

**Constraints:**
- You MUST set file permissions to 600 (owner read/write only)
- You MUST verify the file was written by reading it back
- You MUST NOT log or display the full API key after saving. Show only the first 8 characters.

### 5. Verify Registration

Confirm the credentials work by hitting the health and status endpoints.

```bash
# Health check
curl -s https://api.rhobot.dev/v1/health | jq .

# Auth check
curl -s -H "Authorization: Bearer {api_key}" \
  https://api.rhobot.dev/v1/agents/status | jq .
```

**Constraints:**
- Health check MUST return `{"ok": true}`
- Status check MUST return the agent list with the registered email
- If status check returns 401, credentials are invalid. Report error and suggest re-registering.

### 6. Claim Your Agent

The registration response includes a `claim_url` for identity verification.

**Constraints:**
- You MUST show the claim URL to the user
- You SHOULD offer to open the claim URL on the device using the open-url skill or `termux-open-url`
- Claiming verifies ownership. Unclaimed agents cannot receive email and may be removed.
- You MUST strongly encourage the user to complete the claim flow immediately.

### 7. Report

Summarize what was set up.

**Report template:**
```
Registered: {handle}@rhobot.dev
Agent ID:   {agent_id}
Credentials: ~/.config/rho-cloud/credentials.json
Claim URL:  {claim_url}
Status:     {claimed or pending}

Send a test email to {handle}@rhobot.dev to verify delivery.
Use the rho-cloud-email skill to check your inbox.
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "already taken" on a handle you own | You may have registered previously. Check `~/.config/rho-cloud/credentials.json` for existing credentials. |
| Health check fails | API may be down. Try again in a few minutes. Check `dig api.rhobot.dev` for DNS resolution. |
| Auth check returns 401 | API key may be invalid or corrupted. Re-register with a new handle. |
| Claim URL returns 404 | Claim token may have expired. Re-register to get a fresh claim URL. |
