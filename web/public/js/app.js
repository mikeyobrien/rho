document.addEventListener("alpine:init", () => {
	Alpine.data("rhoApp", () => ({
		view: "chat",
		theme: "dark",
		activeReviewCount: 0,
		_onUiEvent: null,
		_onVisibilityChange: null,

		init() {
			const qsView = new URLSearchParams(window.location.search).get("view");
			if (qsView && ["chat", "memory", "review", "config"].includes(qsView)) {
				this.view = qsView;
			}

			const savedTheme = localStorage.getItem("rho-theme");
			this.theme = savedTheme === "light" ? "light" : "dark";
			document.body.classList.toggle("theme-light", this.theme === "light");

			this._pollReviewSessions(true);

			this._onUiEvent = (event) => {
				const name = event?.detail?.name;
				if (name !== "review_sessions_changed") return;
				this._pollReviewSessions(true);
			};
			window.addEventListener("rho:ui-event", this._onUiEvent);

			this._onVisibilityChange = () => {
				if (!document.hidden) {
					this._pollReviewSessions(true);
				}
			};
			document.addEventListener("visibilitychange", this._onVisibilityChange);
		},

		destroy() {
			if (this._onUiEvent) {
				window.removeEventListener("rho:ui-event", this._onUiEvent);
				this._onUiEvent = null;
			}
			if (this._onVisibilityChange) {
				document.removeEventListener(
					"visibilitychange",
					this._onVisibilityChange,
				);
				this._onVisibilityChange = null;
			}
		},

		toggleTheme() {
			this.theme = this.theme === "light" ? "dark" : "light";
			document.body.classList.toggle("theme-light", this.theme === "light");
			localStorage.setItem("rho-theme", this.theme);
		},

		async _pollReviewSessions(force = false) {
			if (!force && document.hidden) return;
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

			window.dispatchEvent(
				new CustomEvent("rho:view-changed", {
					detail: { view: nextView },
				}),
			);

			if (nextView !== "review") {
				this._pollReviewSessions(true);
			}
		},
	}));
});
