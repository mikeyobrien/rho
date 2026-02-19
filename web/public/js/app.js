document.addEventListener("alpine:init", () => {
	Alpine.data("rhoApp", () => ({
		view: "chat",
		theme: "dark",
		activeReviewCount: 0,
		_reviewPollId: null,

		init() {
			const qsView = new URLSearchParams(window.location.search).get("view");
			if (qsView && ["chat", "memory", "review", "config"].includes(qsView)) {
				this.view = qsView;
			}

			const savedTheme = localStorage.getItem("rho-theme");
			this.theme = savedTheme === "light" ? "light" : "dark";
			document.body.classList.toggle("theme-light", this.theme === "light");

			this._pollReviewSessions(true);
			this._reviewPollId = setInterval(() => {
				this._pollReviewSessions();
			}, 15000);
		},

		destroy() {
			if (this._reviewPollId) clearInterval(this._reviewPollId);
		},

		toggleTheme() {
			this.theme = this.theme === "light" ? "dark" : "light";
			document.body.classList.toggle("theme-light", this.theme === "light");
			localStorage.setItem("rho-theme", this.theme);
		},

		async _pollReviewSessions(force = false) {
			if (!force) {
				if (document.hidden) return;
				// Review dashboard already polls while the review tab is active.
				if (this.view === "review") return;
			}
			try {
				const res = await fetch("/api/review/sessions");
				if (!res.ok) return;
				const sessions = await res.json();
				this.activeReviewCount = sessions.filter((s) => !s.done).length;
			} catch {
				/* ignore */
			}
		},

		setView(nextView) {
			if (!["chat", "memory", "review", "config"].includes(nextView)) return;
			this.view = nextView;

			const url = new URL(window.location.href);
			if (nextView === "chat") url.searchParams.delete("view");
			else url.searchParams.set("view", nextView);
			window.history.replaceState(
				{},
				"",
				`${url.pathname}${url.search}${url.hash}`,
			);

			if (nextView !== "review") {
				this._pollReviewSessions(true);
			}
		},
	}));
});
