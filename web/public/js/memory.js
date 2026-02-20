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
		typeFilter: "all",
		categoryFilter: "",
		searchQuery: "",
		sortBy: "created",
		isLoading: false,
		error: "",

		// Cancel in-flight loads when filters/search change quickly
		loadController: null,

		// Task creation state
		newTaskDescription: "",
		newTaskPriority: "normal",

		// Edit state
		editingId: null,
		editText: "",
		editCategory: "",

		// Add-entry state
		showAddForm: false,
		newEntryType: "learning",
		newEntryText: "",
		newEntryCategory: "",

		async init() {
			await this.load();
		},

		setType(type) {
			this.typeFilter = type;
			this.load();
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
					return (entry.path ? entry.path + ": " : "") + (entry.content || "");
				case "task":
					return entry.description || "";
				case "reminder":
					return (
						(entry.text || entry.description || "") +
						(entry.cadence
							? " [" +
								(entry.cadence.kind === "interval"
									? "every " + entry.cadence.every
									: "daily @ " + entry.cadence["at"]) +
								"]"
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
					case "created":
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

		changeSort() {
			this.updateDisplay();
		},

		isStale(entry) {
			// API doesn't currently return last_used field, so always return false
			// This could be enabled in the future if the API is updated
			return false;
		},

		// ── Edit methods ──

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

		// ── Add-entry methods ──

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

		// ── Task methods ──

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
