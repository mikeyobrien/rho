// Review UI (served from Rho web server)

function _reviewApp() {
	const injected = window.__RHO_REVIEW__ || {};
	const sessionId = injected.sessionId;
	const token = injected.token;

	const base = `/review/${encodeURIComponent(sessionId)}`;
	const api = `${base}/api`;

	function qsToken() {
		return `token=${encodeURIComponent(token || "")}`;
	}

	return {
		files: [],
		activeFileIndex: 0,
		showFilesPanel: window.innerWidth >= 720,
		comments: {},
		activeComment: null, // { fileIndex, startLine, endLine, text } or null
		connected: false,
		connectionLost: false,
		reviewComplete: null,
		contextMessage: null,
		fileWarnings: [],
		_ws: null,

		async init() {
			if (!sessionId || !token) {
				this.reviewComplete = "Invalid review link (missing session or token)";
				return;
			}

			// Fetch optional context message
			try {
				const cfgRes = await fetch(`${api}/config?${qsToken()}`);
				if (cfgRes.ok) {
					const cfg = await cfgRes.json();
					if (cfg.message) this.contextMessage = cfg.message;
				}
			} catch {}

			// Fetch file warnings (skipped files, etc.)
			try {
				const warnRes = await fetch(`${api}/warnings?${qsToken()}`);
				if (warnRes.ok) {
					const warns = await warnRes.json();
					if (Array.isArray(warns) && warns.length > 0)
						this.fileWarnings = warns;
				}
			} catch {}

			try {
				const res = await fetch(`${api}/files?${qsToken()}`);
				if (!res.ok) throw new Error(`Failed to fetch files: ${res.status}`);
				const files = await res.json();

				// Apply syntax highlighting to each file
				this.files = files.map((file) => {
					let highlightedHtml;
					try {
						const lang = file.language;
						if (lang && typeof hljs !== "undefined" && hljs.getLanguage(lang)) {
							highlightedHtml = hljs.highlight(file.content, {
								language: lang,
							}).value;
						} else {
							highlightedHtml = escapeHtml(file.content);
						}
					} catch {
						highlightedHtml = escapeHtml(file.content);
					}

					return {
						...file,
						highlightedLines: highlightedHtml.split("\n"),
					};
				});
			} catch (err) {
				console.error("reviewApp init error:", err);
			}

			// Connect WebSocket
			try {
				const proto = location.protocol === "https:" ? "wss" : "ws";
				const wsUrl = `${proto}://${location.host}${base}/ws?${qsToken()}`;
				const ws = new WebSocket(wsUrl);
				this._ws = ws;

				ws.addEventListener("open", () => {
					this.connected = true;
				});

				ws.addEventListener("message", (event) => {
					try {
						const msg = JSON.parse(event.data);
						if (msg.type === "init") {
							// Connection confirmed
						}
					} catch {}
				});

				ws.addEventListener("close", () => {
					this.connected = false;
					if (!this.reviewComplete) this.connectionLost = true;
				});

				ws.addEventListener("error", () => {
					this.connected = false;
					if (!this.reviewComplete) this.connectionLost = true;
				});
			} catch (err) {
				console.error("WebSocket connection error:", err);
			}
		},

		get activeFile() {
			return this.files[this.activeFileIndex] ?? null;
		},

		selectFile(index) {
			this.activeFileIndex = index;
			this.cancelComment();
			// Collapse sidebar on mobile
			if (window.innerWidth < 720) {
				this.showFilesPanel = false;
			}
		},

		onLineClick(lineNumber, event) {
			// Shift+click extends existing selection
			if (
				event?.shiftKey &&
				this.activeComment &&
				this.activeComment.fileIndex === this.activeFileIndex
			) {
				const anchor = this.activeComment.startLine;
				if (lineNumber >= anchor) {
					this.activeComment.endLine = lineNumber;
				} else {
					this.activeComment.startLine = lineNumber;
				}
				return;
			}

			// Close any existing form, then open new one
			this.activeComment = {
				fileIndex: this.activeFileIndex,
				startLine: lineNumber,
				endLine: lineNumber,
				text: "",
			};

			this.$nextTick(() => this.$refs.commentInput?.focus());
		},

		expandRangeUp() {
			if (!this.activeComment || this.activeComment.startLine <= 1) return;
			this.activeComment.startLine--;
		},

		expandRangeDown() {
			if (!this.activeComment || !this.activeFile) return;
			if (this.activeComment.endLine >= this.activeFile.highlightedLines.length)
				return;
			this.activeComment.endLine++;
		},

		saveComment() {
			if (!this.activeComment || !this.activeFile) return;
			const text = (this.activeComment.text || "").trim();
			if (!text) {
				this.cancelComment();
				return;
			}
			const filePath = this.activeFile.relativePath;
			if (!this.comments[filePath]) this.comments[filePath] = [];
			this.comments[filePath].push({
				startLine: this.activeComment.startLine,
				endLine: this.activeComment.endLine,
				selectedText: this.getSelectedText(),
				comment: text,
			});
			this.cancelComment();
		},

		deleteComment(filePath, index) {
			if (!this.comments[filePath]) return;
			this.comments[filePath].splice(index, 1);
			if (this.comments[filePath].length === 0) delete this.comments[filePath];
		},

		editComment(filePath, index) {
			if (!this.comments[filePath] || !this.comments[filePath][index]) return;
			const cmt = this.comments[filePath][index];
			// Find the file index for this path
			const fileIdx = this.files.findIndex((f) => f.relativePath === filePath);
			if (fileIdx === -1) return;
			// Switch to the file if not already active
			if (this.activeFileIndex !== fileIdx) this.selectFile(fileIdx);
			// Remove the old comment
			this.comments[filePath].splice(index, 1);
			if (this.comments[filePath].length === 0) delete this.comments[filePath];
			// Open form pre-filled
			this.activeComment = {
				fileIndex: fileIdx,
				startLine: cmt.startLine,
				endLine: cmt.endLine,
				text: cmt.comment,
			};
			this.$nextTick(() => this.$refs.commentInput?.focus());
		},

		cancelComment() {
			this.activeComment = null;
		},

		isLineSelected(lineNum) {
			if (!this.activeComment) return false;
			if (this.activeComment.fileIndex !== this.activeFileIndex) return false;
			return (
				lineNum >= this.activeComment.startLine &&
				lineNum <= this.activeComment.endLine
			);
		},

		getSelectedText() {
			if (!this.activeComment || !this.activeFile) return "";
			const lines = this.activeFile.content.split("\n");
			const start = this.activeComment.startLine - 1; // 0-indexed
			const end = this.activeComment.endLine; // slice end is exclusive
			return lines.slice(start, end).join("\n");
		},

		getCommentsForLine(lineNum) {
			if (!this.activeFile) return [];
			const filePath = this.activeFile.relativePath;
			if (!this.comments[filePath]) return [];
			return this.comments[filePath].filter((c) => c.endLine === lineNum);
		},

		isLineCommented(lineNum) {
			if (!this.activeFile) return false;
			const filePath = this.activeFile.relativePath;
			if (!this.comments[filePath]) return false;
			return this.comments[filePath].some(
				(c) => lineNum >= c.startLine && lineNum <= c.endLine,
			);
		},

		totalComments() {
			let count = 0;
			for (const filePath in this.comments) {
				count += this.comments[filePath].length;
			}
			return count;
		},

		fileCommentCount(filePath) {
			if (!this.comments[filePath]) return 0;
			return this.comments[filePath].length;
		},

		dismissWarning(index) {
			this.fileWarnings.splice(index, 1);
		},

		submitReview() {
			if (!this._ws || !this.connected || this.totalComments() === 0) return;
			const allComments = [];
			for (const filePath in this.comments) {
				for (const c of this.comments[filePath]) {
					allComments.push({
						file: filePath,
						startLine: c.startLine,
						endLine: c.endLine,
						selectedText: c.selectedText,
						comment: c.comment,
					});
				}
			}
			this._ws.send(JSON.stringify({ type: "submit", comments: allComments }));
			this.reviewComplete = `Review submitted — ${allComments.length} comment${allComments.length !== 1 ? "s" : ""} sent`;
			setTimeout(() => {
				window.location.href = "/review";
			}, 1500);
		},

		cancelReview() {
			if (this._ws) {
				this._ws.send(JSON.stringify({ type: "cancel" }));
			}
			this.reviewComplete = "Review cancelled";
			setTimeout(() => {
				window.location.href = "/review";
			}, 1000);
		},

		handleKeydown(event) {
			if (event.key !== "Escape") return;
			if (this.reviewComplete) return;

			if (this.activeComment) {
				this.cancelComment();
			} else {
				this.cancelReview();
			}
		},
	};
}

// Escape HTML entities for plain-text fallback
function escapeHtml(text) {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
