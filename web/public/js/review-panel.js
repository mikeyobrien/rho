function rhoReviewDashboard() {
	return {
		loading: true,
		gitStatus: null,
		activeSessionId: "",
		selected: [],
		expanded: [],
		diffs: {},
		reviews: [],
		submissions: [],
		error: null,
		actionError: null,
		isStartingReview: false,
		_refreshTimer: null,
		_isDirty: false,
		_onVisibilityChange: null,
		_onUiEvent: null,
		_onViewChange: null,
		_onActiveSessionChange: null,

		async init() {
			this.activeSessionId = this.readActiveSessionId();
			await this.refresh();
			this.loading = false;

			this._onVisibilityChange = () => {
				if (this.isPanelVisible() && this._isDirty) {
					this.scheduleRefresh(0);
				}
			};
			document.addEventListener("visibilitychange", this._onVisibilityChange);

			this._onViewChange = (event) => {
				if (event?.detail?.view !== "review") return;
				this.scheduleRefresh(0);
			};
			window.addEventListener("rho:view-changed", this._onViewChange);

			this._onUiEvent = (event) => {
				const name = event?.detail?.name;
				if (
					name !== "git_context_changed" &&
					name !== "review_sessions_changed" &&
					name !== "review_submissions_changed"
				) {
					return;
				}
				if (!this.isPanelVisible()) {
					this._isDirty = true;
					return;
				}
				this.scheduleRefresh(80);
			};
			window.addEventListener("rho:ui-event", this._onUiEvent);

			this._onActiveSessionChange = (event) => {
				const nextId =
					typeof event?.detail?.sessionId === "string"
						? event.detail.sessionId.trim()
						: "";
				if (nextId === this.activeSessionId) return;
				this.activeSessionId = nextId;
				this.scheduleRefresh(0);
			};
			window.addEventListener(
				"rho:active-session-changed",
				this._onActiveSessionChange,
			);
		},

		destroy() {
			if (this._refreshTimer) {
				clearTimeout(this._refreshTimer);
				this._refreshTimer = null;
			}
			if (this._onVisibilityChange) {
				document.removeEventListener(
					"visibilitychange",
					this._onVisibilityChange,
				);
				this._onVisibilityChange = null;
			}
			if (this._onUiEvent) {
				window.removeEventListener("rho:ui-event", this._onUiEvent);
				this._onUiEvent = null;
			}
			if (this._onViewChange) {
				window.removeEventListener("rho:view-changed", this._onViewChange);
				this._onViewChange = null;
			}
			if (this._onActiveSessionChange) {
				window.removeEventListener(
					"rho:active-session-changed",
					this._onActiveSessionChange,
				);
				this._onActiveSessionChange = null;
			}
		},

		readActiveSessionId() {
			const store = globalThis?.localStorage;
			if (!store || typeof store.getItem !== "function") return "";
			const value = store.getItem("rho-active-session-id");
			return typeof value === "string" ? value.trim() : "";
		},

		isPanelVisible() {
			if (document.hidden) return false;
			const reviewView = this.$root?.closest?.(".review-view");
			if (!reviewView) return true;
			return reviewView.offsetParent !== null;
		},

		scheduleRefresh(delayMs = 0) {
			if (this._refreshTimer) {
				clearTimeout(this._refreshTimer);
			}
			this._refreshTimer = setTimeout(() => {
				this._refreshTimer = null;
				void this.refresh();
			}, delayMs);
		},

		async refresh() {
			if (!this.loading && !this.isPanelVisible()) {
				this._isDirty = true;
				return;
			}
			try {
				const sessionQuery = this.activeSessionId
					? `?sessionId=${encodeURIComponent(this.activeSessionId)}`
					: "";
				const [statusRes, reviewsRes, submissionsRes] = await Promise.all([
					fetch(`/api/git/status${sessionQuery}`),
					fetch("/api/review/sessions"),
					fetch("/api/review/submissions?status=submitted&limit=20"),
				]);

				if (statusRes.ok) {
					const data = await statusRes.json();
					if (data.error) {
						this.error = data.error;
						this.gitStatus = null;
					} else {
						this.gitStatus = data;
						this.error = null;
					}
				} else if (statusRes.status === 404) {
					this.gitStatus = null;
					this.error = null;
				} else {
					this.error = "Failed to fetch git status";
				}

				if (reviewsRes.ok) {
					const data = await reviewsRes.json();
					this.reviews = data.filter((r) => !r.done);
				}

				if (submissionsRes.ok) {
					const data = await submissionsRes.json();
					this.submissions = Array.isArray(data) ? data : [];
				}

				this._isDirty = false;
			} catch {
				// keep current state
			}
		},

		fileSummary() {
			if (!this.gitStatus) return "";
			const n = this.gitStatus.files.length;
			const totals = this.gitStatus.files.reduce(
				(acc, f) => ({
					add: acc.add + (f.additions || 0),
					del: acc.del + (f.deletions || 0),
				}),
				{ add: 0, del: 0 },
			);
			let s = `${n} file${n !== 1 ? "s" : ""}`;
			if (totals.add) s += ` +${totals.add}`;
			if (totals.del) s += ` −${totals.del}`;
			return s;
		},

		toggleSelect(path) {
			const i = this.selected.indexOf(path);
			if (i >= 0) this.selected.splice(i, 1);
			else this.selected.push(path);
			this.actionError = null;
		},

		selectAll() {
			if (!this.gitStatus) return;
			const allPaths = this.gitStatus.files
				.filter((f) => f.status !== "deleted")
				.map((f) => f.path);
			if (this.selected.length === allPaths.length) this.selected = [];
			else this.selected = [...allPaths];
			this.actionError = null;
		},

		toggleExpand(path) {
			const i = this.expanded.indexOf(path);
			if (i >= 0) this.expanded.splice(i, 1);
			else {
				this.expanded.push(path);
				if (this.diffs[path] === undefined) this.loadDiff(path);
			}
		},

		async loadDiff(path) {
			this.diffs = { ...this.diffs, [path]: false };
			try {
				const sessionQuery = this.activeSessionId
					? `&sessionId=${encodeURIComponent(this.activeSessionId)}`
					: "";
				const res = await fetch(
					`/api/git/diff?file=${encodeURIComponent(path)}${sessionQuery}`,
				);
				const text = res.ok ? await res.text() : "";
				this.diffs = { ...this.diffs, [path]: text || "" };
			} catch {
				this.diffs = { ...this.diffs, [path]: "" };
			}
		},

		async startReview() {
			if (this.selected.length === 0) {
				this.actionError = "Select at least one file to review.";
				return;
			}

			this.actionError = null;
			this.isStartingReview = true;

			try {
				const res = await fetch("/api/review/from-git", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						files: this.selected,
						sessionId: this.activeSessionId || undefined,
					}),
				});

				const data = await res.json().catch(() => null);
				if (!res.ok) {
					this.actionError =
						data?.error ?? `Failed to start review (HTTP ${res.status})`;
					return;
				}

				if (!data?.url) {
					this.actionError = "Review started, but no URL was returned.";
					return;
				}

				window.location.href = data.url;
			} catch (error) {
				this.actionError = error?.message ?? "Failed to start review.";
			} finally {
				this.isStartingReview = false;
			}
		},

		relativeTime(ts) {
			const diff = Date.now() - ts;
			if (diff < 60000) return "just now";
			if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
			if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
			return `${Math.floor(diff / 86400000)}d ago`;
		},

		submissionMeta(entry) {
			const claimed = entry?.claimedBy
				? ` · claimed by ${entry.claimedBy}`
				: "";
			return `${entry.commentCount} comment${entry.commentCount !== 1 ? "s" : ""}${claimed}`;
		},

		renderDiff(diffText) {
			return renderReviewDashDiff(diffText);
		},
	};
}

function renderReviewDashDiff(text) {
	const hunks = parseReviewDashDiff(text || "");
	if (hunks.length === 0)
		return '<div class="reviewdash-diff-empty">no changes</div>';
	let html = "";
	for (const hunk of hunks) {
		html += `<div class="reviewdash-diff-hunk">${escapeHtml(hunk.header)}</div>`;
		for (const line of hunk.lines) {
			const cls =
				line.type === "add" ? "add" : line.type === "del" ? "del" : "ctx";
			const sign =
				line.type === "add" ? "+" : line.type === "del" ? "−" : "&nbsp;";
			html += `<div class="reviewdash-diff-line ${cls}">`;
			html += `<span class="reviewdash-ln">${line.old ?? ""}</span>`;
			html += `<span class="reviewdash-ln">${line.new ?? ""}</span>`;
			html += `<span class="reviewdash-sign">${sign}</span>`;
			html += `<span class="reviewdash-text">${escapeHtml(line.text)}</span>`;
			html += "</div>";
		}
	}
	return html;
}

function parseReviewDashDiff(text) {
	const out = [];
	const lines = text.split("\n");
	let i = 0;
	while (i < lines.length && !lines[i].startsWith("@@")) i++;
	while (i < lines.length) {
		const m = lines[i].match(
			/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@\s?(.*)/,
		);
		if (!m) {
			i++;
			continue;
		}
		const header = m[5] || `@@ -${m[1]},${m[2] || 1} +${m[3]},${m[4] || 1} @@`;
		let oldNum = Number.parseInt(m[1], 10);
		let newNum = Number.parseInt(m[3], 10);
		const hunk = { header, lines: [] };
		i++;
		while (i < lines.length && !lines[i].startsWith("@@")) {
			const l = lines[i];
			if (l.startsWith("+"))
				hunk.lines.push({
					type: "add",
					old: null,
					new: newNum++,
					text: l.slice(1),
				});
			else if (l.startsWith("-"))
				hunk.lines.push({
					type: "del",
					old: oldNum++,
					new: null,
					text: l.slice(1),
				});
			else if (l.startsWith("\\")) {
				// skip
			} else {
				hunk.lines.push({
					type: "ctx",
					old: oldNum++,
					new: newNum++,
					text: l.startsWith(" ") ? l.slice(1) : l,
				});
			}
			i++;
		}
		out.push(hunk);
	}
	return out;
}

function escapeHtml(s) {
	return (s || "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
