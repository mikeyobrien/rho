/**
 * Transient entry blocklist for auto-memory extraction.
 *
 * Patterns that match one-off, non-durable statements are dropped before
 * they reach the brain. This prevents noise from accumulating (snapshot
 * counts, "repo is clean", transient status reports, etc.).
 *
 * See rho GH #34 for the full list of real-world examples that triggered this.
 */

const TRANSIENT_PATTERNS = [
  // Snapshot counts and backup status
  /\d+\s+snapshot.*available/i,
  /repo\s+(is\s+)?clean(,\s*remote\s+is\s+up\s+to\s+date)?/i,
  /remote\s+(is\s+)?up\s+to\s+date/i,

  // One-off review/status events
  /review\s+session\s+(shows|was).*cancelled/i,
  /errors?\s+were?\s+found\s+in/i,

  // Mirror/outage reports
  /the\s+\w+\s+mirror\s+is\s+currently\s+serving/i,

  // Meaningless action records
  /ran\s+(ls|pwd|whoami)\s+(in|at)?\s*(the\s+)?(current\s+)?working?\s*directory/i,
  /^pushed\.?\s*repo\s+is\s+clean$/i,

  // General transient markers
  /\bsession\s+state\b/i,
  /status\s+entry\b/i,
] as const;

/**
 * Returns true if the text matches any transient pattern.
 * Transient entries are dropped before reaching the brain.
 */
export function isTransient(text: string): boolean {
	return TRANSIENT_PATTERNS.some((pattern) => pattern.test(text));
}
