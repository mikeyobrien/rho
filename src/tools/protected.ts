// Rho's own data (its token, keys and storage) is not the agent's to read or change. This is the
// one place that decides whether a path leads there.
//
// A path can reach a directory under more than one name: through a symbolic link, or through a
// second mount of the same directory (Android shows an app's files under both /data/data and
// /data/user/0, and realpath does not turn one into the other). So names are not compared alone:
// the path is resolved, and every directory above it is compared by device and inode.
import { realpathSync, statSync } from "node:fs";
import { dirname, sep } from "node:path";

const names = new Set<string>();
const ids = new Set<string>();
const idOf = (path: string): string | undefined => {
	try {
		const stat = statSync(path);
		return `${stat.dev}:${stat.ino}`;
	} catch {
		return undefined;
	}
};

/** Mark a directory as rho's own. */
export function protect(dir: string): void {
	for (const name of [dir, (() => { try { return realpathSync(dir); } catch { return dir; } })()]) names.add(name);
	const id = idOf(dir);
	if (id) ids.add(id);
}
const named = (path: string): boolean => [...names].some((dir) => path === dir || path.startsWith(dir + sep));

/** Whether an absolute path is, or is inside, a protected directory, by any name. `seen` remembers directories across calls of one walk. */
export function isProtected(path: string, seen?: Map<string, boolean>): boolean {
	if (named(path)) return true;
	// Where it really leads. A path that does not exist yet has no real path: resolve the nearest
	// directory that does exist, which is where a write would land.
	let real = path;
	for (;;) {
		try {
			real = realpathSync(real);
			break;
		} catch {
			const up = dirname(real);
			if (up === real) return false;
			real = up;
		}
	}
	if (named(real)) return true;
	const walked: string[] = [];
	let found = false;
	for (let at = real; ; at = dirname(at)) {
		const known = seen?.get(at);
		if (known !== undefined) {
			found = known;
			break;
		}
		walked.push(at);
		const id = idOf(at);
		if (id !== undefined && ids.has(id)) {
			found = true;
			break;
		}
		if (dirname(at) === at) break;
	}
	// Everything walked below a protected directory is protected; when none was found, nothing walked is.
	if (seen) for (const at of walked) seen.set(at, found);
	return found;
}
