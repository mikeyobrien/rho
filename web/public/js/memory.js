document.addEventListener("alpine:init", () => {
  Alpine.data("rhoMemory", () => ({
    entries: [],
    displayEntries: [],
    stats: { total: 0, learnings: 0, preferences: 0, categories: [] },
    typeFilter: "all",
    categoryFilter: "",
    searchQuery: "",
    sortBy: "created",
    isLoading: false,
    error: "",

    async init() {
      await this.load();
    },

    setType(type) {
      this.typeFilter = type;
      this.load();
    },

    updateDisplay() {
      const sorted = [...this.entries].sort((a, b) => {
        switch (this.sortBy) {
          case "used":
            return (b.used || 0) - (a.used || 0);
          case "alpha":
            return a.text.localeCompare(b.text);
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
      this.isLoading = true;
      this.error = "";
      try {
        const params = new URLSearchParams();
        if (this.typeFilter !== "all") params.set("type", this.typeFilter);
        if (this.categoryFilter) params.set("category", this.categoryFilter);
        if (this.searchQuery.trim()) params.set("q", this.searchQuery.trim());

        const res = await fetch(`/api/memory?${params}`);
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `Request failed (${res.status})`);
        }
        const data = await res.json();
        this.entries = data.entries;
        this.stats = {
          total: data.total,
          learnings: data.learnings,
          preferences: data.preferences,
          categories: data.categories,
        };
        this.updateDisplay();
      } catch (err) {
        this.error = err.message || "Failed to load memory";
      } finally {
        this.isLoading = false;
      }
    },

    changeSort() {
      this.updateDisplay();
    },

    isStale(entry) {
      if (!entry.last_used) return false;
      const days = (Date.now() - new Date(entry.last_used).getTime()) / 86400000;
      return days > 14;
    },

    async remove(entry) {
      if (!confirm(`Delete memory entry?\n\n"${entry.text.substring(0, 100)}..."`)) return;
      try {
        const res = await fetch(`/api/memory/${encodeURIComponent(entry.id)}`, { method: "DELETE" });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || "Delete failed");
        }
        await this.load();
      } catch (err) {
        this.error = err.message || "Failed to delete entry";
      }
    },
  }));
});
