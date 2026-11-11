// Rho's own data (its token, keys and storage) is not the agent's to read or change. This is the
// one place that decides whether a path leads there.
//
// A path can reach a directory under more than one name: through a symbolic link, or through a
// second mount of the same directory (Android shows an app's files under both /data/data and
// /data/user/0, and realpath does not turn one into the other). So names are not compared alone:
// the path is resolved, and every directory above it is compared by device and inode.
import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

// Counted, so that two owners of one directory do not end each other's protection.
const names = new Map<string, number>();
const ids = new Map<string, number>();
const hold = (counts: Map<string, number>, key: string): void => void counts.set(key, (counts.get(key) ?? 0) + 1);
const drop = (counts: Map<string, number>, key: string): void => {
	const left = (counts.get(key) ?? 0) - 1;
	if (left > 0) counts.set(key, left);
	else counts.delete(key);
};
const idOf = (path: string): string | undefined => {
	try {
		const stat = statSync(path);
		return `${stat.dev}:${stat.ino}`;
	} catch {
		return undefined;
	}
};

/**
 * Mark a directory as rho's own. Returns what ends that, for the owner to call when it closes:
 * a directory is remembered by device and inode, and a system hands a deleted directory's inode
 * to a new one, which would then be refused as rho's data for as long as this process lived.
 * A running rho never calls it: its data directory is its own until the process ends.
 */
export function protect(dir: string): () => void {
	const held = [dir, (() => { try { return realpathSync(dir); } catch { return dir; } })()];
	const id = idOf(dir);
	for (const name of held) hold(names, name);
	if (id) hold(ids, id);
	let ended = false;
	return () => {
		if (ended) return;
		ended = true;
		for (const name of held) drop(names, name);
		if (id) drop(ids, id);
	};
}
const named = (path: string): boolean => [...names.keys()].some((dir) => path === dir || path.startsWith(dir + sep));

/** Whether an absolute path is, or is inside, a protected directory, by any name. `seen` remembers directories across calls of one walk. */
export function isProtected(path: string, seen?: Map<string, boolean>): boolean {
	if (named(path)) return true;
	// `..` and doubled slashes are taken out as text first: a part of the path that does not
	// exist yet (`new/../.rho/v2`) must not hide where the rest of it points.
	let real = resolve(path);
	if (named(real)) return true;
	// Where it really leads. A path that does not exist yet has no real path: resolve the nearest
	// directory that does exist, which is where a write would land. A link whose target does not
	// exist yet is followed to that target, because a write through it lands there.
	for (let hops = 0; ; ) {
		try {
			real = realpathSync(real);
			break;
		} catch {
			let target: string | undefined;
			try {
				if (lstatSync(real).isSymbolicLink() && hops++ < 40) target = resolve(dirname(real), readlinkSync(real));
			} catch {
				// not there at all
			}
			if (target !== undefined) {
				if (named(target)) return true;
				real = target;
				continue;
			}
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
