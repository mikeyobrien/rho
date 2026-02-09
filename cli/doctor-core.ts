/**
 * cli/doctor-core.ts — Pure doctor check logic, no filesystem IO.
 *
 * Each check function takes structured input and returns a CheckResult.
 * The IO layer (commands/doctor.ts) gathers system state and feeds it here.
 */

// ---- Types ----

export interface CheckResult {
  status: "ok" | "warn" | "fail";
  message: string;
  fix?: string;
}

export interface CategorizedCheck {
  category: string;
  label: string;
  result: CheckResult;
}

export interface DoctorInput {
  nodeVersion: string | null;
  binaries: Record<string, { version: string | null; exists: boolean }>;
  configFiles: Record<string, { exists: boolean; parseError: string | null }>;
  moduleFiles: Map<string, { missing: string[] }>;
  piIntegration: { settingsExists: boolean; rhoEntryFound: boolean; rhoEntryInSync: boolean | null };
  dataDirs: Record<string, boolean>;
  auth: Record<string, boolean>;
  emailModuleEnabled: boolean;
}

// ---- Minimum versions ----

const MIN_NODE_MAJOR = 20;

// ---- Individual check functions ----

/**
 * Check Node.js version meets minimum requirement.
 */
export function checkNodeVersion(version: string | null): CheckResult {
  if (!version) {
    return {
      status: "fail",
      message: "Node.js not found",
      fix: "Install Node.js v20 or later",
    };
  }

  const match = version.match(/^v?(\d+)/);
  if (!match) {
    return {
      status: "fail",
      message: `Cannot parse Node.js version: ${version}`,
      fix: "Install Node.js v20 or later",
    };
  }

  const major = parseInt(match[1], 10);
  if (major < MIN_NODE_MAJOR) {
    return {
      status: "fail",
      message: `Node.js ${version} is too old (minimum: v${MIN_NODE_MAJOR})`,
      fix: `Upgrade Node.js to v${MIN_NODE_MAJOR} or later`,
    };
  }

  // Strip leading 'v' for display
  const display = version.startsWith("v") ? version.slice(1) : version;
  return { status: "ok", message: `Node.js ${display}` };
}

/**
 * Check if a binary exists on the system.
 * @param name Binary name
 * @param version Detected version (null if not found)
 * @param exists Whether the binary was found
 * @param required If true, missing is "fail" instead of "warn"
 */
export function checkBinaryExists(
  name: string,
  version: string | null,
  exists: boolean,
  required: boolean = false,
): CheckResult {
  if (!exists) {
    return {
      status: required ? "fail" : "warn",
      message: `${name} not found`,
      fix: `Install ${name}`,
    };
  }

  const display = version ? `${name} ${version}` : name;
  return { status: "ok", message: display };
}

/**
 * Check a config file's existence and parse status.
 * @param filename Config file name (e.g. "init.toml")
 * @param exists Whether the file exists
 * @param parseError Parse error message, or null if OK
 * @param required If true (default), missing is "fail"; otherwise "warn"
 */
export function checkConfigFile(
  filename: string,
  exists: boolean,
  parseError: string | null,
  required: boolean = true,
): CheckResult {
  if (!exists) {
    return {
      status: required ? "fail" : "warn",
      message: `${filename} not found`,
      fix: `Run \`rho init\` to create ${filename}`,
    };
  }

  if (parseError) {
    return {
      status: "fail",
      message: `${filename}: ${parseError}`,
      fix: `Fix the syntax in ${filename}`,
    };
  }

  return { status: "ok", message: `${filename} valid` };
}

/**
 * Check that all enabled modules have their files on disk.
 * @param modules Map of module name → { missing: path[] }
 */
export function checkModuleFiles(
  modules: Map<string, { missing: string[] }>,
): CheckResult {
  const problems: string[] = [];

  for (const [name, info] of modules) {
    if (info.missing.length > 0) {
      problems.push(`${name}: ${info.missing.join(", ")}`);
    }
  }

  if (problems.length === 0) {
    return { status: "ok", message: "All module files present" };
  }

  return {
    status: "fail",
    message: `Missing module files: ${problems.join("; ")}`,
    fix: "Run `rho sync` or reinstall the package",
  };
}

/**
 * Check pi integration (settings.json has Rho entry).
 */
export function checkPiIntegration(
  settingsExists: boolean,
  rhoEntryFound: boolean,
  rhoEntryInSync: boolean | null,
): CheckResult {
  if (!settingsExists) {
    return {
      status: "fail",
      message: "settings.json not found",
      fix: "Run `rho sync` to create the pi package entry",
    };
  }

  if (!rhoEntryFound) {
    return {
      status: "fail",
      message: "No Rho entry in settings.json",
      fix: "Run `rho sync` to add the Rho package entry",
    };
  }

  if (rhoEntryInSync === false) {
    return {
      status: "warn",
      message: "Rho entry in settings.json is out of sync",
      fix: "Run `rho sync` to update filters and managed packages",
    };
  }

  return { status: "ok", message: "Rho entry in settings.json" };
}

/**
 * Check a data directory exists.
 */
export function checkDataDir(name: string, exists: boolean): CheckResult {
  if (!exists) {
    return {
      status: "warn",
      message: `~/.rho/${name}/ not found`,
      fix: "Run `rho sync` or `rho init` to create data directories",
    };
  }

  return { status: "ok", message: `~/.rho/${name}/ exists` };
}

/**
 * Check an auth file.
 * @param name Auth name ("pi" or "rho-cloud")
 * @param exists Whether the auth file exists
 * @param needed Whether this auth is currently needed (based on enabled modules)
 */
export function checkAuthFile(
  name: string,
  exists: boolean,
  needed: boolean,
): CheckResult {
  if (!needed) {
    return { status: "ok", message: `${name} auth not required` };
  }

  if (!exists) {
    const fixCmd = name === "rho-cloud" ? "rho login" : "pi login";
    return {
      status: "warn",
      message: `${name} credentials not found`,
      fix: `Run \`${fixCmd}\` to authenticate`,
    };
  }

  return { status: "ok", message: `${name} auth present` };
}

// ---- Run all checks ----

/**
 * Run all doctor checks given structured input.
 * Returns categorized results for display.
 */
export function runAllChecks(input: DoctorInput): CategorizedCheck[] {
  const results: CategorizedCheck[] = [];

  // -- System --
  results.push({
    category: "System",
    label: "Node.js",
    result: checkNodeVersion(input.nodeVersion),
  });

  for (const [name, info] of Object.entries(input.binaries)) {
    const required = name === "pi"; // pi is required
    results.push({
      category: "System",
      label: name,
      result: checkBinaryExists(name, info.version, info.exists, required),
    });
  }

  // -- Config --
  for (const [filename, info] of Object.entries(input.configFiles)) {
    const required = filename === "init.toml";
    results.push({
      category: "Config",
      label: filename,
      result: checkConfigFile(filename, info.exists, info.parseError, required),
    });
  }

  // -- Packages --
  results.push({
    category: "Packages",
    label: "Module files",
    result: checkModuleFiles(input.moduleFiles),
  });

  // -- Pi Integration --
  results.push({
    category: "Pi Integration",
    label: "Rho entry in settings.json",
    result: checkPiIntegration(
      input.piIntegration.settingsExists,
      input.piIntegration.rhoEntryFound,
      input.piIntegration.rhoEntryInSync,
    ),
  });

  // -- Data --
  for (const [name, exists] of Object.entries(input.dataDirs)) {
    results.push({
      category: "Data",
      label: `~/.rho/${name}/`,
      result: checkDataDir(name, exists),
    });
  }

  // -- Auth --
  results.push({
    category: "Auth",
    label: "Pi auth",
    result: checkAuthFile("pi", input.auth.pi ?? false, true),
  });
  results.push({
    category: "Auth",
    label: "Rho Cloud auth",
    result: checkAuthFile(
      "rho-cloud",
      input.auth["rho-cloud"] ?? false,
      input.emailModuleEnabled,
    ),
  });

  return results;
}

// ---- Formatting ----

const STATUS_ICONS: Record<string, string> = {
  ok: "✓",
  warn: "!",
  fail: "✗",
};

const STATUS_COLORS: Record<string, string> = {
  ok: "\x1b[32m",    // green
  warn: "\x1b[33m",  // yellow
  fail: "\x1b[31m",  // red
};
const RESET = "\x1b[0m";

/**
 * Format check results for terminal display.
 */
export function formatResults(checks: CategorizedCheck[]): string {
  const lines: string[] = [];
  let currentCategory = "";

  for (const check of checks) {
    if (check.category !== currentCategory) {
      if (currentCategory !== "") lines.push("");
      lines.push(`\x1b[1m${check.category}${RESET}`);
      currentCategory = check.category;
    }

    const icon = STATUS_ICONS[check.result.status] ?? "?";
    const color = STATUS_COLORS[check.result.status] ?? "";
    lines.push(`  ${color}${icon}${RESET} ${check.result.message}`);

    if (check.result.fix && check.result.status !== "ok") {
      lines.push(`    ${check.result.fix}`);
    }
  }

  return lines.join("\n");
}

/**
 * Count results by status.
 */
export function summaryCounts(checks: CategorizedCheck[]): {
  ok: number;
  warn: number;
  fail: number;
  total: number;
} {
  let ok = 0;
  let warn = 0;
  let fail = 0;

  for (const check of checks) {
    switch (check.result.status) {
      case "ok":
        ok++;
        break;
      case "warn":
        warn++;
        break;
      case "fail":
        fail++;
        break;
    }
  }

  return { ok, warn, fail, total: checks.length };
}
