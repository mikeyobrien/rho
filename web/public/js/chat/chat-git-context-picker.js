import { toFiniteNumber } from "./rendering-and-usage.js";

function gitProjectFromCwd(cwd) {
	if (typeof cwd !== "string") return "";
	const normalized = cwd.trim().replace(/[\\/]+$/, "");
	if (!normalized || normalized === "/") return "";
	return normalized.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

function getActiveSessionId(vm) {
	return typeof vm.activeSessionId === "string"
		? vm.activeSessionId.trim()
		: "";
}

function ensurePickerState(vm) {
	if (typeof vm.showGitProjectPicker !== "boolean") {
		vm.showGitProjectPicker = false;
	}
	if (!Array.isArray(vm.gitProjects)) {
		vm.gitProjects = [];
	}
	if (typeof vm.gitProjectsLoading !== "boolean") {
		vm.gitProjectsLoading = false;
	}
	if (typeof vm.gitProjectsError !== "string") {
		vm.gitProjectsError = "";
	}
	if (typeof vm.selectedGitProjectId !== "string") {
		vm.selectedGitProjectId = "";
	}
	if (typeof vm.activeGitCwd !== "string") {
		vm.activeGitCwd = "";
	}
}

export const rhoChatGitContextMethods = {
	bindGitFooterPickerTrigger() {
		const projectButton = document.querySelector(".footer .footer-project");
		if (!projectButton || projectButton.dataset.rhoGitPickerBound === "1") {
			return;
		}
		projectButton.dataset.rhoGitPickerBound = "1";
		projectButton.addEventListener("click", () => {
			this.openGitProjectPicker();
		});
	},

	async refreshGitProject() {
		ensurePickerState(this);
		const sessionId = getActiveSessionId(this);
		const query = sessionId
			? `?sessionId=${encodeURIComponent(sessionId)}`
			: "";
		try {
			const response = await fetch(`/api/git/status${query}`, {
				cache: "no-store",
			});
			if (!response.ok) {
				this.activeGitProject = "";
				this.activeGitPath = "";
				this.activeGitCwd = "";
				this.updateFooter();
				return;
			}
			const payload = await response.json();
			const cwd = typeof payload?.cwd === "string" ? payload.cwd : "";
			const branch =
				typeof payload?.branch === "string" ? payload.branch.trim() : "";
			const project = gitProjectFromCwd(cwd);
			this.activeGitProject = [project, branch].filter(Boolean).join("/");
			this.activeGitPath = [cwd, branch].filter(Boolean).join("/");
			this.activeGitCwd = cwd;
		} catch {
			this.activeGitProject = "";
			this.activeGitPath = "";
			this.activeGitCwd = "";
		}
		this.updateFooter();
	},

	updateFooter() {
		const projectEl = document.querySelector(".footer .footer-project");
		const tokensEl = document.querySelector(".footer .footer-tokens");
		const costEl = document.querySelector(".footer .footer-cost");
		const statusEl = document.querySelector(".footer .footer-status");
		const extStatusEl = document.querySelector(".footer .footer-ext-status");

		if (projectEl) {
			const isDesktop =
				window.matchMedia?.("(min-width: 1024px)")?.matches ?? false;
			const project = isDesktop
				? this.activeGitPath || this.activeGitProject
				: this.activeGitProject;
			projectEl.textContent = `project: ${project || "--"}`;
			projectEl.title = this.activeGitPath || this.activeGitProject || "";
		}
		if (tokensEl) {
			const tokens = toFiniteNumber(this.sessionStats?.tokens) ?? 0;
			tokensEl.textContent = `tokens: ${tokens.toLocaleString()}`;
		}
		if (costEl) {
			const cost = toFiniteNumber(this.sessionStats?.cost) ?? 0;
			costEl.textContent = `cost: $${cost.toFixed(4)}`;
		}
		if (statusEl) {
			statusEl.textContent = `status: ${this.isStreaming ? "streaming" : "idle"}`;
			statusEl.classList.toggle("streaming", this.isStreaming);
		}
		if (extStatusEl) {
			extStatusEl.textContent = this.extensionStatus || "";
			extStatusEl.style.display = this.extensionStatus ? "inline" : "none";
		}
	},

	async openGitProjectPicker() {
		ensurePickerState(this);
		if (!this.isChatViewVisible()) {
			return;
		}
		if (!getActiveSessionId(this)) {
			this.showToast("Select a chat session first.", "warning", 2200);
			return;
		}
		this.showGitProjectPicker = true;
		this.gitProjectsLoading = true;
		this.gitProjectsError = "";
		try {
			const response = await fetch("/api/git/projects", { cache: "no-store" });
			if (!response.ok) {
				this.gitProjects = [];
				this.gitProjectsError = "Failed to load repositories.";
				return;
			}
			const payload = await response.json();
			this.gitProjects = Array.isArray(payload?.projects)
				? payload.projects
				: [];
			if (this.gitProjects.length > 0) {
				const activeMatch = this.gitProjects.find(
					(repo) =>
						typeof repo?.cwd === "string" && repo.cwd === this.activeGitCwd,
				);
				const hasCurrent = this.gitProjects.some(
					(repo) => repo?.id === this.selectedGitProjectId,
				);
				this.selectedGitProjectId =
					typeof activeMatch?.id === "string"
						? activeMatch.id
						: hasCurrent
							? this.selectedGitProjectId
							: this.gitProjects[0]?.id || "";
			}
		} catch {
			this.gitProjects = [];
			this.gitProjectsError = "Failed to load repositories.";
		} finally {
			this.gitProjectsLoading = false;
		}
	},

	closeGitProjectPicker() {
		ensurePickerState(this);
		this.showGitProjectPicker = false;
	},

	selectGitProject(repoId) {
		ensurePickerState(this);
		this.selectedGitProjectId = typeof repoId === "string" ? repoId : "";
	},

	async applyGitProjectSelection() {
		ensurePickerState(this);
		if (this.isStreaming) {
			this.gitProjectsError =
				"Wait for streaming to finish before switching project context.";
			return;
		}
		const sessionId = getActiveSessionId(this);
		if (!sessionId || !this.selectedGitProjectId) {
			return;
		}
		this.gitProjectsLoading = true;
		this.gitProjectsError = "";
		try {
			const response = await fetch("/api/git/context", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					sessionId,
					repoId: this.selectedGitProjectId,
				}),
			});
			const payload = await response.json().catch(() => ({}));
			if (!response.ok) {
				this.gitProjectsError =
					payload?.error || "Failed to set session project context.";
				return;
			}
			this.showGitProjectPicker = false;
			const sessionFile = this.getActiveSessionFile();
			if (sessionFile) {
				this.activeRpcSessionId = "";
				this.activeRpcSessionFile = sessionFile;
				this.startRpcSession(sessionFile, { sessionId });
			}
			await this.refreshGitProject();
		} catch {
			this.gitProjectsError = "Failed to set session project context.";
		} finally {
			this.gitProjectsLoading = false;
		}
	},
};
