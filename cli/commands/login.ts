/**
 * rho login — Authenticate with pi providers (and show auth status).
 *
 * This is the canonical Node implementation (legacy bash wrappers removed).
 *
 * Usage:
 *   rho login
 *   rho login --status
 *   rho login --logout <provider>
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const HOME = process.env.HOME || os.homedir();
const AUTH_FILE = path.join(HOME, ".pi", "agent", "auth.json");
const RHO_CLOUD_CREDS = path.join(HOME, ".config", "rho-cloud", "credentials.json");

export async function run(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`rho login [options]

Authenticate with LLM providers using pi's built-in /login flow.

Options:
  (no args)              Open pi. Then type /login to authenticate.
  --status               Show which providers are configured
  --logout <provider>    Remove credentials for a provider
  -h, --help             Show this help

`);
    return;
  }

  const logoutIdx = args.indexOf("--logout");
  if (logoutIdx !== -1) {
    const provider = args[logoutIdx + 1];
    if (!provider || provider.startsWith("-")) {
      console.error("Error: --logout requires a provider name.");
      process.exit(1);
    }
    doLogout(provider);
    return;
  }

  if (args.includes("--status") || args.includes("-s")) {
    showStatus();
    return;
  }

  // Default: open pi and instruct user
  ensurePiAvailable();
  console.log("Starting pi session for authentication.");
  console.log("Type /login to open the provider selector.");
  console.log("");

  const r = spawnSync("pi", [], { stdio: "inherit" });
  process.exit(r.status ?? 0);
}

function ensurePiAvailable(): void {
  const r = spawnSync("pi", ["--help"], { stdio: "ignore" });
  if (r.error || r.status !== 0) {
    console.error("Error: pi is not installed or not working.");
    console.error("Install: npm i -g @mariozechner/pi-coding-agent");
    process.exit(1);
  }
}

function showStatus(): void {
  // pi auth
  if (!fs.existsSync(AUTH_FILE)) {
    console.log("No pi credentials configured.");
    console.log("Run `rho login` to authenticate.");
  } else {
    try {
      const raw = fs.readFileSync(AUTH_FILE, "utf-8");
      const auth = JSON.parse(raw) as Record<string, any>;
      const now = Date.now();

      console.log("Provider credentials (~/.pi/agent/auth.json):\n");
      for (const [provider, cred] of Object.entries(auth)) {
        const type = (cred as any)?.type ?? "unknown";
        let status = "";
        const expires = (cred as any)?.expires;
        if (typeof expires === "number") {
          if (now > expires) {
            status = "expired";
          } else {
            const hours = Math.round((expires - now) / 3600000);
            status = hours > 24 ? `${Math.round(hours / 24)}d remaining` : `${hours}h remaining`;
          }
        } else {
          status = "no expiry";
        }
        const refreshable = (cred as any)?.refresh ? ", auto-refresh" : "";
        console.log(`  ${provider.padEnd(22)}${String(type).padEnd(12)}${status}${refreshable}`);
      }
    } catch {
      console.log("Could not parse ~/.pi/agent/auth.json");
    }
  }

  // rho cloud creds
  console.log("");
  if (fs.existsSync(RHO_CLOUD_CREDS)) {
    console.log("Rho Cloud credentials: present (~/.config/rho-cloud/credentials.json)");
  } else {
    console.log("Rho Cloud credentials: missing (~/.config/rho-cloud/credentials.json)");
    console.log("  To set up agent email, run the rho-cloud-onboard skill inside pi.");
  }
}

function doLogout(provider: string): void {
  if (!fs.existsSync(AUTH_FILE)) {
    console.error("No pi credentials configured.");
    process.exit(1);
  }

  let auth: Record<string, any>;
  try {
    auth = JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8"));
  } catch {
    console.error("Could not parse auth.json");
    process.exit(1);
  }

  if (!auth[provider]) {
    console.error(`Provider "${provider}" not found.`);
    console.error(`Configured: ${Object.keys(auth).join(", ") || "(none)"}`);
    process.exit(1);
  }

  delete auth[provider];
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2) + "\n");
  console.log(`Removed credentials for ${provider}`);
}
