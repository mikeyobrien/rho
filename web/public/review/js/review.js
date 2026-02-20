// Review UI (served from Rho web server)
function reviewApp() {
	const injected = window.__RHO_REVIEW__ || {};
	const sessionId = injected.sessionId;
	const token = injected.token;
	const base = `/review/${encodeURIComponent(sessionId)}`;
	const api = `${base}/api`;
	function qsToken() {
		return `token=${encodeURIComponent(token || "")}`;
	}
	function initialWrapPreference() {
		try {
			const saved = localStorage.getItem("rho.review.wrapLines");
			if (saved === "1") return true;
			if (saved === "0") return false;
		} catch {}
		return window.innerWidth < 720;
	}
	function createCommentId() {
		return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
	}
	function applyStoredTheme() {
		let theme = "dark";
		try {
			theme = localStorage.getItem("rho-theme") === "light" ? "light" : "dark";
		} catch {}
		document.body.classList.toggle("theme-light", theme === "light");
		const dark = document.getElementById("hljs-theme-dark");
		const light = document.getElementById("hljs-theme-light");
		if (dark) dark.disabled = theme === "light";
		if (light) light.disabled = theme !== "light";
	}
	return {
		files: [],
		activeFileIndex: 0,
		showFilesPanel: window.innerWidth >= 720,
		wrapLongLines: initialWrapPreference(),
		comments: {},
		expandedComments: {},
		activeComment: null, // { fileIndex, startLine, endLine, text, commentId } or null
		commentInputFocused: false,
		_blurTimer: null,
		connected: false,
		connectionLost: false,
		reviewComplete: null,
		contextMessage: null,
		fileWarnings: [],
		isNavHidden: false,
		_lastCodeScrollTop: 0,
		_ws: null,
		_beforeUnloadHandler: null,
		async init() {
			applyStoredTheme();
			if (!sessionId || !token) {
				this.reviewComplete = "Invalid review link (missing session or token)";
				return;
			}
			this.installBeforeUnloadGuard();
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
				if (window.innerWidth < 720 && this.files.length <= 1) {
					this.showFilesPanel = false;
				}
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
		installBeforeUnloadGuard() {
			if (this._beforeUnloadHandler) return;
			this._beforeUnloadHandler = (event) => {
				if (!this.hasPendingLeaveRisk()) return;
				event.preventDefault();
				event.returnValue = "";
				return "";
			};
			window.addEventListener("beforeunload", this._beforeUnloadHandler);
		},
		get activeFile() {
			return this.files[this.activeFileIndex] ?? null;
		},
		get isKeyboardMode() {
			return this.commentInputFocused && window.innerWidth < 720;
		},
		hasUnsavedDraft() {
			if (!this.activeComment) return false;
			return Boolean((this.activeComment.text || "").trim());
		},
		hasUnsubmittedComments() {
			return this.totalComments() > 0;
		},
		hasPendingLeaveRisk() {
			if (this.reviewComplete) return false;
			return this.hasUnsavedDraft() || this.hasUnsubmittedComments();
		},
		leaveWarningText(reason = "leave this review") {
			const draft = this.hasUnsavedDraft();
			const comments = this.hasUnsubmittedComments();
			if (draft && comments) {
				return `You have an unsaved comment draft and unsubmitted review comments. ${reason} anyway?`;
			}
			if (draft) {
				return `You have an unsaved comment draft. ${reason} anyway?`;
			}
			if (comments) {
				return `You have review comments that are not submitted yet. ${reason} anyway?`;
			}
			return "";
		},
		confirmLeaveIfNeeded(reason = "leave this review") {
			if (!this.hasPendingLeaveRisk()) return true;
			return window.confirm(this.leaveWarningText(reason));
		},
		guardLeaveNavigation(event) {
			if (this.confirmLeaveIfNeeded()) return;
			event.preventDefault();
			event.stopPropagation();
		},
		onCodeScroll(event) {
			if (window.innerWidth >= 720) {
				this.isNavHidden = false;
				this._lastCodeScrollTop = 0;
				return;
			}
			const target = event?.target ?? this.$refs.codeArea;
			if (!target) return;
			const currentTop = Math.max(0, target.scrollTop || 0);
			const delta = currentTop - this._lastCodeScrollTop;
			const absDelta = Math.abs(delta);
			if (currentTop <= 8) {
				this.isNavHidden = false;
				this._lastCodeScrollTop = currentTop;
				return;
			}
			if (absDelta < 8) {
				this._lastCodeScrollTop = currentTop;
				return;
			}
			if (delta > 0 && currentTop > 72) {
				this.isNavHidden = true;
			} else if (delta < 0) {
				this.isNavHidden = false;
			}
			this._lastCodeScrollTop = currentTop;
		},
		selectFile(index) {
			this.activeFileIndex = index;
			this.cancelComment();
			this.isNavHidden = false;
			// Collapse sidebar on mobile
			if (window.innerWidth < 720) {
				this.showFilesPanel = false;
			}
		},
		toggleWrapLines() {
			this.wrapLongLines = !this.wrapLongLines;
			try {
				localStorage.setItem(
					"rho.review.wrapLines",
					this.wrapLongLines ? "1" : "0",
				);
			} catch {}
		},
		onCommentInputFocus() {
			if (this._blurTimer) {
				clearTimeout(this._blurTimer);
				this._blurTimer = null;
			}
			this.commentInputFocused = true;
			this.isNavHidden = false;
		},
		onCommentInputBlur() {
			if (this._blurTimer) clearTimeout(this._blurTimer);
			this._blurTimer = setTimeout(() => {
				this.commentInputFocused = false;
				this._blurTimer = null;
			}, 120);
		},
		onLineClick(lineNumber, event) {
			// Shift+click extends existing selection
			if (
				event?.shiftKey &&
				this.activeComment &&
				this.activeComment.fileIndex === this.activeFileIndex
			) {
				const anchor = this.activeComment.startLine;
				const nextStart =
					lineNumber >= anchor ? this.activeComment.startLine : lineNumber;
				const nextEnd =
					lineNumber >= anchor ? lineNumber : this.activeComment.endLine;
				if (
					nextStart !== this.activeComment.startLine ||
					nextEnd !== this.activeComment.endLine
				) {
					this.pushRangeHistory();
					this.activeComment.startLine = nextStart;
					this.activeComment.endLine = nextEnd;
				}
				return;
			}
			// Close any existing form, then open new one
			this.activeComment = {
				fileIndex: this.activeFileIndex,
				startLine: lineNumber,
				endLine: lineNumber,
				text: "",
				commentId: null,
				rangeHistory: [],
			};
			this.$nextTick(() => this.$refs.commentInput?.focus());
		},
		toggleCommentExpanded(comment) {
			if (!comment?.id) return;
			if (this.expandedComments[comment.id]) {
				delete this.expandedComments[comment.id];
			} else {
				this.expandedComments[comment.id] = true;
			}
		},
		isCommentExpanded(comment) {
			if (!comment?.id) return false;
			return this.expandedComments[comment.id] === true;
		},
		pushRangeHistory() {
			if (!this.activeComment) return;
			if (!Array.isArray(this.activeComment.rangeHistory)) {
				this.activeComment.rangeHistory = [];
			}
			const snapshot = {
				startLine: this.activeComment.startLine,
				endLine: this.activeComment.endLine,
			};
			const last =
				this.activeComment.rangeHistory[
					this.activeComment.rangeHistory.length - 1
				];
			if (
				last &&
				last.startLine === snapshot.startLine &&
				last.endLine === snapshot.endLine
			) {
				return;
			}
			this.activeComment.rangeHistory.push(snapshot);
			if (this.activeComment.rangeHistory.length > 40) {
				this.activeComment.rangeHistory.shift();
			}
		},
		canUndoRange() {
			return Boolean(this.activeComment?.rangeHistory?.length);
		},
		undoRangeChange() {
			if (!this.activeComment || !this.canUndoRange()) return;
			const previous = this.activeComment.rangeHistory.pop();
			if (!previous) return;
			this.activeComment.startLine = previous.startLine;
			this.activeComment.endLine = previous.endLine;
		},
		expandRangeUp() {
			if (!this.activeComment || this.activeComment.startLine <= 1) return;
			this.pushRangeHistory();
			this.activeComment.startLine--;
		},
		expandRangeDown() {
			if (!this.activeComment || !this.activeFile) return;
			if (this.activeComment.endLine >= this.activeFile.highlightedLines.length)
				return;
			this.pushRangeHistory();
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
			const commentId = this.activeComment.commentId || createCommentId();
			this.comments[filePath].push({
				id: commentId,
				startLine: this.activeComment.startLine,
				endLine: this.activeComment.endLine,
				selectedText: this.getSelectedText(),
				comment: text,
			});
			delete this.expandedComments[commentId]; // collapsed by default
			this.cancelComment();
		},
		deleteComment(filePath, index) {
			if (!this.comments[filePath]) return;
			const target = this.comments[filePath][index];
			if (target?.id) delete this.expandedComments[target.id];
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
			if (cmt.id) delete this.expandedComments[cmt.id];
			// Open form pre-filled
			this.activeComment = {
				fileIndex: fileIdx,
				startLine: cmt.startLine,
				endLine: cmt.endLine,
				text: cmt.comment,
				commentId: cmt.id || createCommentId(),
				rangeHistory: [],
			};
			this.$nextTick(() => this.$refs.commentInput?.focus());
		},
		cancelComment() {
			this.activeComment = null;
			this.commentInputFocused = false;
			if (this._blurTimer) {
				clearTimeout(this._blurTimer);
				this._blurTimer = null;
			}
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
			if (!this.confirmLeaveIfNeeded("Cancel this review")) return;
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
				if (this.hasUnsavedDraft()) {
					const discard = window.confirm("Discard your unsaved comment draft?");
					if (!discard) return;
				}
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
