const DEFAULT_PENDING_STALE_MS = 30_000;

function normalizeThresholdMs(value) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return DEFAULT_PENDING_STALE_MS;
	}
	return Math.floor(parsed);
}

function hasStaleEntries(pendingMap, now, thresholdMs) {
	if (!(pendingMap instanceof Map)) {
		return false;
	}

	for (const entry of pendingMap.values()) {
		if (!entry || typeof entry !== "object") {
			continue;
		}
		const queuedAt = Number(entry.queuedAt ?? 0);
		if (!Number.isFinite(queuedAt) || queuedAt <= 0) {
			continue;
		}
		if (now - queuedAt >= thresholdMs) {
			return true;
		}
	}

	return false;
}

function collectPendingMaps(vm) {
	const maps = [];
	if (!vm || typeof vm !== "object") {
		return maps;
	}

	if (vm.pendingRpcCommands instanceof Map) {
		maps.push(vm.pendingRpcCommands);
	}

	if (!(vm.sessionStateById instanceof Map)) {
		return maps;
	}

	for (const state of vm.sessionStateById.values()) {
		const pendingMap = state?.pendingRpcCommands;
		if (!(pendingMap instanceof Map)) {
			continue;
		}
		maps.push(pendingMap);
	}

	return maps;
}

export function hasStalePendingRpcCommands(vm, now = Date.now()) {
	const thresholdMs = normalizeThresholdMs(vm?.wsPendingStaleMs);
	for (const pendingMap of collectPendingMaps(vm)) {
		if (hasStaleEntries(pendingMap, now, thresholdMs)) {
			return true;
		}
	}
	return false;
}

export function bumpPendingRpcQueuedAt(vm, now = Date.now()) {
	for (const pendingMap of collectPendingMaps(vm)) {
		for (const [commandId, entry] of pendingMap.entries()) {
			if (!entry || typeof entry !== "object") {
				continue;
			}
			pendingMap.set(commandId, {
				...entry,
				queuedAt: now,
			});
		}
	}
}
