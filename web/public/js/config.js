document.addEventListener("alpine:init", () => {
	Alpine.data("rhoConfig", () => ({
		content: "",
		lastSavedContent: "",
		dirty: false,
		isSaving: false,
		saveStatus: "",
		error: "",
		filePath: "",
		rhoVersion: "",
		theme: "dark",
		isMobileShell: false,
		codexUsage: null,
		codexUsageError: "",
		isLoadingCodexUsage: false,
		kiroUsage: null,
		kiroUsageError: "",
		isLoadingKiroUsage: false,
		modifierKeys: false,

		async init() {
			const savedTheme = localStorage.getItem("rho-theme");
			this.theme = savedTheme === "light" ? "light" : "dark";
			this.applyTheme(this.theme);
			this.isMobileShell = this.detectMobileShell();
			this.modifierKeys =
				localStorage.getItem("rho-mobile-modifier-keys") === "1";
			await this.loadConfig();
			await this.loadProviderUsage();
		},

		async loadConfig() {
			try {
				const res = await fetch("/api/config");
				if (!res.ok) {
					const body = await res.json().catch(() => ({}));
					throw new Error(body.error ?? `Failed to load (${res.status})`);
				}
				const data = await res.json();
				this.filePath = data.path ?? "";
				this.rhoVersion = typeof data.version === "string" ? data.version : "";
				this.content = data.content ?? "";
				this.lastSavedContent = this.content;
			} catch (err) {
				this.error = err.message ?? "Failed to load config";
			}
		},

		async loadProviderUsage() {
			this.isLoadingCodexUsage = true;
			this.isLoadingKiroUsage = true;
			this.codexUsageError = "";
			this.kiroUsageError = "";
			try {
				const res = await fetch("/api/provider-usage");
				if (!res.ok) {
					const body = await res.json().catch(() => ({}));
					throw new Error(
						body.error ?? `Failed to load provider usage (${res.status})`,
					);
				}
				const data = await res.json();
				this.codexUsage = data?.codex ?? null;
				this.codexUsageError = this.codexUsage?.error ?? "";
				this.kiroUsage = data?.kiro ?? null;
				this.kiroUsageError = this.kiroUsage?.error ?? "";
			} catch (err) {
				this.codexUsage = null;
				this.codexUsageError = err.message ?? "Failed to load provider usage";
				this.kiroUsage = null;
				this.kiroUsageError = err.message ?? "Failed to load provider usage";
			} finally {
				this.isLoadingCodexUsage = false;
				this.isLoadingKiroUsage = false;
			}
		},

		applyTheme(theme) {
			const nextTheme = theme === "light" ? "light" : "dark";
			document.body.classList.toggle("theme-light", nextTheme === "light");
			localStorage.setItem("rho-theme", nextTheme);
			this.theme = nextTheme;
		},

		toggleTheme() {
			this.applyTheme(this.theme === "light" ? "dark" : "light");
		},

		toggleModifierKeys() {
			this.modifierKeys = !this.modifierKeys;
			localStorage.setItem(
				"rho-mobile-modifier-keys",
				this.modifierKeys ? "1" : "0",
			);
			window.dispatchEvent(
				new CustomEvent("rho:modifier-keys-changed", {
					detail: { enabled: this.modifierKeys },
				}),
			);
		},

		themeButtonLabel() {
			return this.theme === "light" ? "Switch to dark" : "Switch to light";
		},

		rhoVersionLabel() {
			if (!this.rhoVersion) return "";
			return this.rhoVersion.startsWith("v")
				? this.rhoVersion
				: `v${this.rhoVersion}`;
		},

		detectMobileShell() {
			try {
				return (
					new URLSearchParams(window.location.search).get("mobile_shell") ===
					"1"
				);
			} catch {
				return false;
			}
		},

		switchToProfilePicker() {
			window.location.href = "http://localhost/?picker=1";
		},

		statusMessage() {
			if (this.isSaving) return "Saving...";
			if (this.saveStatus === "saved") return "Saved";
			if (this.saveStatus === "error") return this.error || "Save failed";
			if (this.dirty) return "Unsaved changes";
			if (this.content) return "Up to date";
			return "";
		},

		codexUsageVisible() {
			return this.codexUsage?.loggedIn === true;
		},

		codexUsageAvailable() {
			return this.codexUsage?.available === true;
		},

		codexPlanLabel() {
			const planType = this.codexUsage?.planType;
			return typeof planType === "string" && planType
				? `Plan: ${planType}`
				: "Signed in with openai-codex";
		},

		formatDuration(seconds) {
			const value = Number(seconds);
			if (!Number.isFinite(value) || value <= 0) return "";
			if (value < 60) return `${Math.round(value)}s`;
			if (value < 3600) return `${Math.ceil(value / 60)}m`;
			if (value < 86400) return `${Math.ceil(value / 3600)}h`;
			return `${Math.ceil(value / 86400)}d`;
		},

		codexWindowRemainingLabel(kind) {
			const prefix = kind === "secondary" ? "secondary" : "primary";
			const remaining = this.codexUsage?.[`${prefix}RemainingPercent`];
			const resetSeconds = this.codexUsage?.[`${prefix}ResetAfterSeconds`];
			if (!Number.isFinite(Number(remaining))) {
				return "Unavailable";
			}
			const parts = [`${Math.round(Number(remaining))}% remaining`];
			const resetLabel = this.formatDuration(resetSeconds);
			if (resetLabel) {
				parts.push(`resets in ${resetLabel}`);
			}
			return parts.join(" · ");
		},

		kiroUsageVisible() {
			return this.kiroUsage?.loggedIn === true;
		},

		kiroUsageAvailable() {
			return this.kiroUsage?.available === true;
		},

		kiroPlanLabel() {
			const planTitle = this.kiroUsage?.planTitle;
			return typeof planTitle === "string" && planTitle
				? `Plan: ${planTitle}`
				: "Signed in with Kiro";
		},

		kiroResetLabel() {
			const daysUntilReset = this.kiroUsage?.daysUntilReset;
			const resetDate = this.kiroUsage?.resetDate;
			const parts = [];
			if (resetDate) parts.push(`resets on ${resetDate}`);
			if (Number.isFinite(daysUntilReset)) {
				parts.push(
					`${daysUntilReset} day${daysUntilReset === 1 ? "" : "s"} left`,
				);
			}
			return parts.length > 0 ? parts.join(" · ") : "";
		},

		kiroUsageBucketsLabel() {
			const buckets = this.kiroUsage?.usageBuckets ?? [];
			if (buckets.length === 0) return "";
			const first = buckets[0];
			const parts = [`${first.used} used`];
			if (first.limit) parts.push(`of ${first.limit}`);
			return parts.join(" ");
		},

		kiroBonusLabel() {
			const bonus = this.kiroUsage?.bonusCredits;
			if (!bonus) return "";
			const parts = [`Bonus: ${bonus.used} used`];
			if (bonus.limit) parts.push(`of ${bonus.limit}`);
			if (bonus.expiresAt) parts.push(`expires ${bonus.expiresAt}`);
			return parts.join(" ");
		},

		kiroOverageLabel() {
			const status = this.kiroUsage?.overageStatus;
			return status ? `Overages: ${status}` : "";
		},

		handleInput() {
			this.dirty = this.content !== this.lastSavedContent;
			if (this.dirty) this.saveStatus = "";
		},

		async save() {
			this.isSaving = true;
			this.error = "";
			this.saveStatus = "";
			try {
				const res = await fetch("/api/config", {
					method: "PUT",
					headers: { "Content-Type": "text/plain" },
					body: this.content,
				});
				if (!res.ok) {
					const body = await res.json().catch(() => ({}));
					throw new Error(body.error ?? `Save failed (${res.status})`);
				}
				this.lastSavedContent = this.content;
				this.dirty = false;
				this.saveStatus = "saved";
				setTimeout(() => {
					if (this.saveStatus === "saved") this.saveStatus = "";
				}, 2000);
			} catch (err) {
				this.error = err.message ?? "Failed to save";
				this.saveStatus = "error";
			} finally {
				this.isSaving = false;
			}
		},
	}));
});
