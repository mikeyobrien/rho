function formatTaskDate(value) {
  if (!value) {
    return "--";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "2-digit",
  });
}

async function fetchTasksJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error ?? `Request failed (${response.status})`);
  }
  return response.json();
}

document.addEventListener("alpine:init", () => {
  Alpine.data("rhoTasks", () => ({
    tasks: [],
    filter: "pending",
    newDescription: "",
    newPriority: "normal",
    isLoading: false,
    isSubmitting: false,
    error: "",

    async init() {
      await this.loadTasks();
    },

    async loadTasks() {
      this.isLoading = true;
      this.error = "";
      try {
        this.tasks = await fetchTasksJson("/api/tasks?filter=all");
      } catch (error) {
        this.error = error.message ?? "Failed to load tasks";
      } finally {
        this.isLoading = false;
      }
    },

    filteredTasks() {
      if (this.filter === "all") return this.tasks;
      if (this.filter === "done") return this.tasks.filter((task) => task.status === "done");
      return this.tasks.filter((task) => task.status === "pending");
    },

    pendingCount() {
      return this.tasks.filter((task) => task.status === "pending").length;
    },

    doneCount() {
      return this.tasks.filter((task) => task.status === "done").length;
    },

    setFilter(filter) {
      this.filter = filter;
    },

    async addTask() {
      const desc = this.newDescription.trim();
      if (!desc) {
        return;
      }
      this.isSubmitting = true;
      this.error = "";
      try {
        await fetchTasksJson("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ description: desc, priority: this.newPriority }),
        });
        this.newDescription = "";
        this.newPriority = "normal";
        await this.loadTasks();
      } catch (error) {
        this.error = error.message ?? "Failed to add task";
      } finally {
        this.isSubmitting = false;
      }
    },

    async toggleTask(task) {
      if (!task) return;
      const nextStatus = task.status === "done" ? "pending" : "done";
      this.error = "";
      try {
        await fetchTasksJson(`/api/tasks/${task.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: nextStatus }),
        });
        await this.loadTasks();
      } catch (error) {
        this.error = error.message ?? "Failed to update task";
      }
    },

    async removeTask(task) {
      if (!task) return;
      this.error = "";
      try {
        await fetchTasksJson(`/api/tasks/${task.id}`, { method: "DELETE" });
        await this.loadTasks();
      } catch (error) {
        this.error = error.message ?? "Failed to remove task";
      }
    },

    formatDate(value) {
      return formatTaskDate(value);
    },
  }));
});
