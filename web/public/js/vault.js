document.addEventListener("alpine:init", () => {
	Alpine.data("rhoVault", () => ({
		notes: [],
		stats: { total: 0, byType: {}, orphanCount: 0 },
		typeFilter: "all",
		searchQuery: "",
		searchResults: null,
		isLoading: false,
		error: "",

		// Detail view state
		activeNote: null,
		noteLoading: false,
		noteMap: {},

		// Debounce timer
		_searchTimer: null,

		init() {
			this.loadNotes();
		},

		async loadNotes() {
			this.isLoading = true;
			this.error = "";
			try {
				const params = new URLSearchParams();
				if (this.typeFilter !== "all") params.set("type", this.typeFilter);
				const res = await fetch(`/api/vault?${params}`);
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const data = await res.json();
				this.notes = data.notes;
				this.stats = data.stats;
				this.noteMap = {};
				for (const n of data.notes) {
					this.noteMap[n.slug] = n;
				}
			} catch (e) {
				this.error = e.message || "Failed to load vault";
			} finally {
				this.isLoading = false;
			}
		},

		setTypeFilter(type) {
			this.typeFilter = type;
			this.searchQuery = "";
			this.searchResults = null;
			this.loadNotes();
		},

		onSearchInput() {
			clearTimeout(this._searchTimer);
			const q = this.searchQuery.trim();
			if (!q) {
				this.searchResults = null;
				return;
			}
			this._searchTimer = setTimeout(() => this.doSearch(q), 300);
		},

		async doSearch(q) {
			try {
				const params = new URLSearchParams({ q });
				if (this.typeFilter !== "all") params.set("type", this.typeFilter);
				const res = await fetch(`/api/vault/search?${params}`);
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const data = await res.json();
				this.searchResults = data.results;
			} catch (e) {
				this.error = e.message || "Search failed";
			}
		},

		async openNote(slug) {
			this.noteLoading = true;
			this.error = "";
			try {
				const res = await fetch(`/api/vault/${encodeURIComponent(slug)}`);
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				this.activeNote = await res.json();
			} catch (e) {
				this.error = e.message || "Failed to load note";
			} finally {
				this.noteLoading = false;
			}
		},

		closeNote() {
			this.activeNote = null;
		},

		renderMarkdown(content) {
			if (!content) return "";
			let html = "";
			try {
				html = marked.parse(content);
			} catch {
				html = `<pre>${this.escapeHtml(content)}</pre>`;
			}
			// Render [[wikilinks]] as clickable links
			html = html.replace(
				/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
				(_, slug, label) => {
					const trimSlug = slug.trim();
					const display = label
						? label.trim()
						: this.noteMap[trimSlug]?.title || trimSlug;
					const exists = !!this.noteMap[trimSlug];
					const cls = exists
						? "vault-wikilink"
						: "vault-wikilink vault-wikilink-missing";
					return `<a class="${cls}" data-slug="${this.escapeHtml(trimSlug)}">${this.escapeHtml(display)}</a>`;
				},
			);
			return html;
		},

		handleContentClick(event) {
			const link = event.target.closest(".vault-wikilink");
			if (!link) return;
			event.preventDefault();
			const slug = link.dataset.slug;
			if (slug) this.openNote(slug);
		},

		escapeHtml(str) {
			const div = document.createElement("div");
			div.textContent = str;
			return div.innerHTML;
		},

		typeBadgeClass(type) {
			const map = {
				concept: "vault-type-concept",
				reference: "vault-type-reference",
				pattern: "vault-type-pattern",
				project: "vault-type-project",
				log: "vault-type-log",
				moc: "vault-type-moc",
			};
			return map[type] || "vault-type-unknown";
		},

		get displayNotes() {
			if (this.searchResults !== null) return this.searchResults;
			return this.notes;
		},

		get typeOptions() {
			const types = ["all"];
			if (this.stats.byType) {
				for (const t of Object.keys(this.stats.byType).sort()) {
					types.push(t);
				}
			}
			return types;
		},
	}));
});
