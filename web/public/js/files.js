function formatFileTimestamp(value) {
  if (!value) {
    return "--";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function fetchFilesJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error ?? `Request failed (${response.status})`);
  }
  return response.json();
}

function isFilesMobileViewport() {
  return window.innerWidth <= 720;
}

document.addEventListener("alpine:init", () => {
  Alpine.data("rhoFiles", () => ({
    files: [],
    activeFilePath: "",
    activeFile: null,
    content: "",
    lastSavedContent: "",
    dirty: false,
    isLoadingFiles: false,
    isLoadingFile: false,
    isSaving: false,
    saveStatus: "",
    error: "",
    conflict: null,
    ws: null,
    reconnectTimer: null,

    // Mobile collapsible panel state
    showFilesPanel: true,

    async init() {
      await this.loadFiles();
      this.connectWebSocket();
    },

    statusMessage() {
      if (this.conflict) {
        return "External update detected";
      }
      if (this.isSaving) {
        return "Saving...";
      }
      if (this.saveStatus === "saved") {
        return "Saved";
      }
      if (this.saveStatus === "updated") {
        return "Updated";
      }
      if (this.saveStatus === "error") {
        return this.error || "Save failed";
      }
      if (this.dirty) {
        return "Unsaved changes";
      }
      if (this.activeFile) {
        return "Up to date";
      }
      return "";
    },

    async loadFiles() {
      this.isLoadingFiles = true;
      this.error = "";
      try {
        const files = await fetchFilesJson("/api/files");
        this.files = files;
        this.syncActiveFile();
      } catch (error) {
        this.error = error.message ?? "Failed to load files";
      } finally {
        this.isLoadingFiles = false;
      }
    },

    syncActiveFile() {
      if (!this.activeFilePath) {
        return;
      }
      const match = this.files.find((file) => file.path === this.activeFilePath);
      if (match) {
        this.activeFile = match;
      } else {
        this.resetEditor();
      }
    },

    toggleFilesPanel() {
      this.showFilesPanel = !this.showFilesPanel;
    },

    async selectFile(file) {
      if (!file || file.isDirectory) {
        return;
      }
      if (file.path === this.activeFilePath) {
        return;
      }
      this.activeFilePath = file.path;
      this.activeFile = file;

      // Auto-collapse files panel on mobile after selection
      if (isFilesMobileViewport()) {
        this.showFilesPanel = false;
      }

      await this.loadFileContent(file);
    },

    async loadFileContent(file) {
      if (!file) {
        return;
      }
      this.isLoadingFile = true;
      this.error = "";
      this.saveStatus = "";
      this.conflict = null;
      this.dirty = false;
      try {
        const data = await fetchFilesJson(`/api/file?path=${encodeURIComponent(file.path)}`);
        this.content = data.content ?? "";
        this.lastSavedContent = this.content;
        this.dirty = false;
      } catch (error) {
        this.error = error.message ?? "Failed to load file";
        this.content = "";
        this.lastSavedContent = "";
      } finally {
        this.isLoadingFile = false;
      }
    },

    handleInput() {
      this.dirty = this.content !== this.lastSavedContent;
      if (this.dirty) {
        this.saveStatus = "";
      }
    },

    async saveFile() {
      if (!this.activeFile || this.activeFile.isDirectory) {
        return;
      }
      this.isSaving = true;
      this.error = "";
      this.saveStatus = "";
      try {
        const response = await fetch(`/api/file?path=${encodeURIComponent(this.activeFile.path)}`,
          {
            method: "PUT",
            headers: { "Content-Type": "text/plain" },
            body: this.content,
          }
        );
        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          throw new Error(error.error ?? `Request failed (${response.status})`);
        }
        this.lastSavedContent = this.content;
        this.dirty = false;
        this.saveStatus = "saved";
        this.conflict = null;
        setTimeout(() => {
          if (this.saveStatus === "saved") {
            this.saveStatus = "";
          }
        }, 2000);
      } catch (error) {
        this.error = error.message ?? "Failed to save file";
        this.saveStatus = "error";
      } finally {
        this.isSaving = false;
      }
    },

    formatTimestamp(value) {
      return formatFileTimestamp(value);
    },

    connectWebSocket() {
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const wsUrl = `${protocol}://${window.location.host}/ws`;
      const socket = new WebSocket(wsUrl);
      this.ws = socket;

      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ type: "subscribe_files" }));
      });

      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") {
          return;
        }
        let payload = null;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }
        if (!payload || typeof payload !== "object") {
          return;
        }
        if (payload.type === "files" && Array.isArray(payload.files)) {
          this.files = payload.files;
          this.syncActiveFile();
        }
        if (payload.type === "file_changed") {
          this.handleExternalChange(payload);
        }
      });

      socket.addEventListener("close", () => {
        this.scheduleReconnect();
      });

      socket.addEventListener("error", () => {
        this.scheduleReconnect();
      });
    },

    scheduleReconnect() {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
      }
      this.reconnectTimer = setTimeout(() => {
        this.connectWebSocket();
      }, 3000);
    },

    updateFileMetadata(pathValue) {
      const index = this.files.findIndex((file) => file.path === pathValue);
      if (index === -1) {
        return;
      }
      const updated = { ...this.files[index] };
      updated.lastModified = new Date().toISOString();
      this.files.splice(index, 1, updated);
      if (this.activeFilePath === pathValue) {
        this.activeFile = updated;
      }
    },

    handleExternalChange(payload) {
      const filePath = payload.path;
      const content = payload.content ?? "";
      if (!filePath) {
        return;
      }
      this.updateFileMetadata(filePath);
      if (this.activeFilePath !== filePath) {
        return;
      }
      if (this.dirty) {
        this.conflict = { content };
        return;
      }
      this.content = content;
      this.lastSavedContent = content;
      this.saveStatus = "updated";
      setTimeout(() => {
        if (this.saveStatus === "updated") {
          this.saveStatus = "";
        }
      }, 2000);
    },

    applyExternalUpdate() {
      if (!this.conflict) {
        return;
      }
      this.content = this.conflict.content ?? "";
      this.lastSavedContent = this.content;
      this.dirty = false;
      this.conflict = null;
      this.saveStatus = "updated";
      setTimeout(() => {
        if (this.saveStatus === "updated") {
          this.saveStatus = "";
        }
      }, 2000);
    },

    dismissConflict() {
      this.conflict = null;
    },

    resetEditor() {
      this.activeFilePath = "";
      this.activeFile = null;
      this.content = "";
      this.lastSavedContent = "";
      this.dirty = false;
      this.saveStatus = "";
      this.conflict = null;
    },
  }));
});
