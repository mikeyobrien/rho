document.addEventListener("alpine:init", () => {
	Alpine.data("rhoMemory", () => ({
		entries: [],
		displayEntries: [],
		stats: {
			total: 0,
			behaviors: 0,
			identity: 0,
			user: 0,
			learnings: 0,
			preferences: 0,
			contexts: 0,
			tasks: 0,
			reminders: 0,
			categories: [],
		},
		autoMemory: {
			effective: { enabled: true, source: "default" },
			settings: {
				autoMemory: true,
				autoMemoryModel: null,
				autoMemoryMode: "idle",
				autoMemoryDebounceMs: 8000,
			},
			status: {
				phase: "idle",
				pendingCount: 0,
				activeRunId: null,
				activeSessionId: null,
				activeLeafId: null,
				queuedAt: null,
				startedAt: null,
				finishedAt: null,
				lastRunId: null,
				lastStatus: null,
				lastSavedTotal: 0,
				lastError: null,
				updatedAt: null,
			},
			runs: [],
		},
		typeFilter: "all",
		categoryFilter: "",
		searchQuery: "",
		sortBy: "created",
		isLoading: false,
		autoMemoryLoading: false,
		autoMemoryLoaded: false,
		error: "",
		autoMemoryError: "",
		loadController: null,
		newTaskDescription: "",
		newTaskPriority: "normal",
		editingId: null,
		editText: "",
		editCategory: "",
		showAddForm: false,
		newEntryType: "learning",
		newEntryText: "",
		newEntryCategory: "",
		_onViewChanged: null,
		_onVisibilityChange: null,
		_onAutoMemoryUpdated: null,
		_autoMemoryStatusObserver: null,

		async init() {
			this._onViewChanged = async (event) => {
				if (event?.detail?.view === "memory") {
					await this.loadAll();
				}
			};
			window.addEventListener("rho:view-changed", this._onViewChanged);

			this._onVisibilityChange = async () => {
				if (!document.hidden && this.isMemoryViewVisible()) {
					await this.loadAll();
				}
			};
			document.addEventListener("visibilitychange", this._onVisibilityChange);

			this._onAutoMemoryUpdated = async () => {
				if (this.isMemoryViewVisible()) {
					await this.loadAll();
				}
			};
			window.addEventListener(
				"rho:auto-memory-updated",
				this._onAutoMemoryUpdated,
			);

			const footerStatusEl = document.querySelector(".footer-ext-status");
			if (footerStatusEl && typeof MutationObserver !== "undefined") {
				this._autoMemoryStatusObserver = new MutationObserver(async () => {
					const text = String(footerStatusEl.textContent || "");
					if (/\bmem\b/i.test(text) && this.isMemoryViewVisible()) {
						await this.loadAutoMemory();
					}
				});
				this._autoMemoryStatusObserver.observe(footerStatusEl, {
					childList: true,
					subtree: true,
					characterData: true,
				});
			}

			if (this.isMemoryViewVisible()) {
				await this.loadAll();
			}
		},

		destroy() {
			if (this._onViewChanged) {
				window.removeEventListener("rho:view-changed", this._onViewChanged);
				this._onViewChanged = null;
			}
			if (this._onVisibilityChange) {
				document.removeEventListener(
					"visibilitychange",
					this._onVisibilityChange,
				);
				this._onVisibilityChange = null;
			}
			if (this._onAutoMemoryUpdated) {
				window.removeEventListener(
					"rho:auto-memory-updated",
					this._onAutoMemoryUpdated,
				);
				this._onAutoMemoryUpdated = null;
			}
			if (this._autoMemoryStatusObserver) {
				this._autoMemoryStatusObserver.disconnect();
				this._autoMemoryStatusObserver = null;
			}
			if (this.loadController) {
				this.loadController.abort();
				this.loadController = null;
			}
		},

		isMemoryViewVisible() {
			const params = new URLSearchParams(window.location.search);
			return (params.get("view") || "chat") === "memory";
		},

		async loadAll() {
			await Promise.all([this.load(), this.loadAutoMemory()]);
		},

		cardText(entry) {
			switch (entry.type) {
				case "behavior":
					return entry.text || "";
				case "identity":
				case "user":
					return entry.value || "";
				case "learning":
					return entry.text || "";
				case "preference":
					return entry.text || "";
				case "context":
					return (entry.path ? `${entry.path}: ` : "") + (entry.content || "");
				case "task":
					return entry.description || "";
				case "reminder":
					return (
						(entry.text || entry.description || "") +
						(entry.cadence
							? ` [${
									entry.cadence.kind === "interval"
										? `every ${entry.cadence.every}`
										: `daily @ ${entry.cadence.at}`
								}]`
							: "")
					);
				default:
					return (
						entry.text ||
						entry.value ||
						entry.description ||
						entry.content ||
						JSON.stringify(entry)
					);
			}
		},

		updateDisplay() {
			const sorted = [...this.entries].sort((a, b) => {
				switch (this.sortBy) {
					case "used":
						return (b.used || 0) - (a.used || 0);
					case "alpha": {
						const aText = a._alpha || this.cardText(a).toLowerCase();
						const bText = b._alpha || this.cardText(b).toLowerCase();
						return aText.localeCompare(bText);
					}
					case "last_used":
						return (b.last_used || "").localeCompare(a.last_used || "");
					default:
						return (b.created || "").localeCompare(a.created || "");
				}
			});
			this.displayEntries = sorted;
		},

		async load() {
			if (this.loadController) {
				this.loadController.abort();
			}
			const controller = new AbortController();
			this.loadController = controller;

			this.isLoading = true;
			this.error = "";
			try {
				const params = new URLSearchParams();
				if (this.typeFilter !== "all") params.set("type", this.typeFilter);
				if (this.categoryFilter) params.set("category", this.categoryFilter);
				if (this.searchQuery.trim()) params.set("q", this.searchQuery.trim());

				const res = await fetch(`/api/memory?${params}`, {
					signal: controller.signal,
				});
				if (!res.ok) {
					const err = await res.json().catch(() => ({}));
					throw new Error(err.error || `Request failed (${res.status})`);
				}
				const data = await res.json();

				this.entries = (data.entries || []).map((entry) => {
					const displayText = this.cardText(entry);
					return {
						...entry,
						_displayText: displayText,
						_alpha: displayText.toLowerCase(),
					};
				});

				this.stats = {
					total: data.total,
					behaviors: data.behaviors,
					identity: data.identity,
					user: data.user,
					learnings: data.learnings,
					preferences: data.preferences,
					contexts: data.contexts,
					tasks: data.tasks,
					reminders: data.reminders,
					categories: data.categories,
				};
				this.updateDisplay();
			} catch (err) {
				if (err && err.name === "AbortError") {
					return;
				}
				this.error = err.message || "Failed to load brain";
			} finally {
				if (this.loadController === controller) {
					this.loadController = null;
					this.isLoading = false;
				}
			}
		},

		async loadAutoMemory() {
			this.autoMemoryLoading = true;
			this.autoMemoryError = "";
			try {
				const [statusRes, runsRes] = await Promise.all([
					fetch("/api/auto-memory/status"),
					fetch("/api/auto-memory/runs?limit=8"),
				]);
				if (!statusRes.ok) {
					const err = await statusRes.json().catch(() => ({}));
					throw new Error(err.error || `Request failed (${statusRes.status})`);
				}
				if (!runsRes.ok) {
					const err = await runsRes.json().catch(() => ({}));
					throw new Error(err.error || `Request failed (${runsRes.status})`);
				}
				const statusData = await statusRes.json();
				const runsData = await runsRes.json();
				this.autoMemory = {
					effective: statusData.effective || {
						enabled: true,
						source: "default",
					},
					settings: statusData.settings || this.autoMemory.settings,
					status: statusData.status || this.autoMemory.status,
					runs: Array.isArray(runsData.runs) ? runsData.runs : [],
				};
				this.autoMemoryLoaded = true;
			} catch (err) {
				this.autoMemoryError = err.message || "Failed to load auto-memory";
			} finally {
				this.autoMemoryLoading = false;
			}
		},

		autoMemoryModeLabel() {
			return `${this.autoMemory.settings.autoMemoryMode} / ${this.autoMemory.settings.autoMemoryDebounceMs}ms`;
		},

		autoMemoryPhaseLabel() {
			const phase = this.autoMemory.status?.phase || "idle";
			if (phase === "queued") return "queued";
			if (phase === "running") return "saving";
			if (phase === "error") return "error";
			return "idle";
		},

		autoMemoryLastSummary() {
			const status = this.autoMemory.status || {};
			if (status.lastError) return status.lastError;
			if (status.lastStatus === "ok") {
				return `${status.lastSavedTotal || 0} saved`;
			}
			if (status.lastStatus === "parse_failed") return "parse failed";
			if (status.lastStatus === "no_response") return "no response";
			if (status.lastStatus === "error") return "error";
			return "no runs yet";
		},

		autoMemorySavedLabel(run) {
			const total = Number(run?.saved?.total ?? 0);
			return `${Number.isFinite(total) ? total : 0} saved`;
		},

		formatTimestamp(value) {
			if (!value || typeof value !== "string") return "--";
			return value.replace("T", " ").replace("Z", " UTC");
		},

		setType(type) {
			this.typeFilter = type;
			this.load();
		},

		changeSort() {
			this.updateDisplay();
		},

		isStale(_entry) {
			return false;
		},

		startEdit(entry) {
			this.editingId = entry.id;
			this.editText = entry.text;
			this.editCategory = entry.category || "";
		},

		cancelEdit() {
			this.editingId = null;
			this.editText = "";
			this.editCategory = "";
		},

		async saveEdit(entry) {
			if (!this.editText.trim()) return;
			try {
				const body = { text: this.editText.trim() };
				if (entry.type === "preference") {
					body.category = this.editCategory.trim() || entry.category;
				}
				const res = await fetch(`/api/memory/${encodeURIComponent(entry.id)}`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				});
				if (!res.ok) {
					const err = await res.json().catch(() => ({}));
					throw new Error(err.error || "Update failed");
				}
				this.cancelEdit();
				await this.load();
			} catch (err) {
				this.error = err.message || "Failed to update entry";
			}
		},

		toggleAddForm() {
			this.showAddForm = !this.showAddForm;
			if (!this.showAddForm) {
				this.newEntryType = "learning";
				this.newEntryText = "";
				this.newEntryCategory = "";
			}
		},

		async addEntry() {
			if (!this.newEntryText.trim()) return;
			try {
				const body = {
					type: this.newEntryType,
					text: this.newEntryText.trim(),
				};
				if (this.newEntryType === "preference") {
					body.category = this.newEntryCategory.trim() || "General";
				}
				const res = await fetch("/api/memory", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				});
				if (!res.ok) {
					const err = await res.json().catch(() => ({}));
					throw new Error(err.error || "Create failed");
				}
				this.showAddForm = false;
				this.newEntryType = "learning";
				this.newEntryText = "";
				this.newEntryCategory = "";
				await this.load();
			} catch (err) {
				this.error = err.message || "Failed to add entry";
			}
		},

		async remove(entry) {
			const preview = (entry._displayText || this.cardText(entry)).substring(
				0,
				100,
			);
			if (!confirm(`Delete brain entry?\n\n"${preview}..."`)) return;
			try {
				const res = await fetch(`/api/memory/${encodeURIComponent(entry.id)}`, {
					method: "DELETE",
				});
				if (!res.ok) {
					const err = await res.json().catch(() => ({}));
					throw new Error(err.error || "Delete failed");
				}
				await this.load();
			} catch (err) {
				this.error = err.message || "Failed to delete entry";
			}
		},

		async addTask() {
			const desc = this.newTaskDescription.trim();
			if (!desc) return;
			this.error = "";
			try {
				const res = await fetch("/api/tasks", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						description: desc,
						priority: this.newTaskPriority,
					}),
				});
				if (!res.ok) {
					const err = await res.json().catch(() => ({}));
					throw new Error(err.error || "Failed to add task");
				}
				this.newTaskDescription = "";
				this.newTaskPriority = "normal";
				await this.load();
			} catch (err) {
				this.error = err.message || "Failed to add task";
			}
		},

		async toggleTask(task) {
			if (!task) return;
			const nextStatus = task.status === "done" ? "pending" : "done";
			this.error = "";
			try {
				const res = await fetch(`/api/tasks/${task.id}`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ status: nextStatus }),
				});
				if (!res.ok) {
					const err = await res.json().catch(() => ({}));
					throw new Error(err.error || "Failed to update task");
				}
				await this.load();
			} catch (err) {
				this.error = err.message || "Failed to toggle task";
			}
		},

		async removeTask(task) {
			if (!task) return;
			this.error = "";
			try {
				const res = await fetch(`/api/tasks/${task.id}`, { method: "DELETE" });
				if (!res.ok) {
					const err = await res.json().catch(() => ({}));
					throw new Error(err.error || "Failed to delete task");
				}
				await this.load();
			} catch (err) {
				this.error = err.message || "Failed to delete task";
			}
		},
	}));
});
