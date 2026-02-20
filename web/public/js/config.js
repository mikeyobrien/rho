document.addEventListener("alpine:init", () => {
	Alpine.data("rhoConfig", () => ({
		content: "",
		lastSavedContent: "",
		dirty: false,
		isSaving: false,
		saveStatus: "",
		error: "",
		filePath: "",
		theme: "dark",

		async init() {
			const savedTheme = localStorage.getItem("rho-theme");
			this.theme = savedTheme === "light" ? "light" : "dark";
			this.applyTheme(this.theme);

			try {
				const res = await fetch("/api/config");
				if (!res.ok) {
					const body = await res.json().catch(() => ({}));
					throw new Error(body.error ?? `Failed to load (${res.status})`);
				}
				const data = await res.json();
				this.filePath = data.path ?? "";
				this.content = data.content ?? "";
				this.lastSavedContent = this.content;
			} catch (err) {
				this.error = err.message ?? "Failed to load config";
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

		themeButtonLabel() {
			return this.theme === "light" ? "Switch to dark" : "Switch to light";
		},

		statusMessage() {
			if (this.isSaving) return "Saving...";
			if (this.saveStatus === "saved") return "Saved";
			if (this.saveStatus === "error") return this.error || "Save failed";
			if (this.dirty) return "Unsaved changes";
			if (this.content) return "Up to date";
			return "";
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
