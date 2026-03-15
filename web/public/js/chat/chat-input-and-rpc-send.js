import * as primitives from "./constants-and-primitives.js";
import * as modelThinking from "./model-thinking-and-toast.js";
import * as renderingUsage from "./rendering-and-usage.js";
import * as toolSemantics from "./tool-semantics.js";

const { renderMarkdown, highlightCodeBlocks } = {
	...primitives,
	...toolSemantics,
	...renderingUsage,
	...modelThinking,
};

export const rhoChatInputMethods = {
	setupPullToRefresh() {
		this.$nextTick(() => {
			const app = this.$root;
			if (!app || typeof PullToRefresh === "undefined") return;
			if (this._ptr) {
				this._ptr.destroy();
				this._ptr = null;
			}
			this._ptr = new PullToRefresh(app, {
				onRefresh: () => {
					window.location.reload();
				},
			});
		});
	},

	setupLazyRendering() {
		this.$nextTick(() => {
			const thread = this.$refs.thread;
			if (!thread) return;

			if (this._lazyObserver) {
				this._lazyObserver.disconnect();
			}

			this._lazyObserver = new IntersectionObserver(
				(entries) => {
					for (const entry of entries) {
						if (!entry.isIntersecting) continue;
						const msgEl = entry.target;
						const msgId = msgEl.dataset.messageId;
						if (!msgId) continue;

						const wasNearBottom = this.isThreadNearBottom(120);

						const msg = this.renderedMessages.find((m) => m.id === msgId);
						if (!msg || !msg.parts) continue;

						let modified = false;
						for (const part of msg.parts) {
							if (part.isRendered) continue;
							if (part.type === "thinking") {
								part.content = renderMarkdown(part.rawContent || part.content);
								part.isRendered = true;
								modified = true;
								continue;
							}
							if (part.type === "text") {
								if (part.render === "html") {
									part.content = renderMarkdown(
										part.rawContent || part.content,
									);
									modified = true;
								}
								part.isRendered = true;
							}
						}

						if (modified) {
							this.$nextTick(() => {
								highlightCodeBlocks(msgEl);
								if (wasNearBottom && !this.userScrolledUp) {
									this.scrollThreadToBottom();
								}
							});
						}

						this._lazyObserver?.unobserve(msgEl);
					}
				},
				{ rootMargin: "200px" }, // Pre-render 200px before visible
			);

			for (const el of thread.querySelectorAll("[data-message-id]")) {
				this._lazyObserver?.observe(el);
			}
		});
	},

	setupKeyboardShortcuts() {
		document.addEventListener("keydown", (e) => {
			if (e.key === "Escape") {
				if (this.extensionDialog) {
					this.dismissDialog(null);
					e.preventDefault();
					return;
				}
			}
		});
	},

	handleComposerKeydown(e) {
		if (this.handleSlashAcKeydown(e)) {
			return;
		}
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			this.handlePromptSubmit();
		}
	},

	handleComposerInput(event) {
		const el = event.target;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
		this.updateSlashAutocomplete();
	},

	handleComposerPaste(event) {
		const items = event.clipboardData?.items;
		if (!items) return;
		for (const item of items) {
			if (item.type.startsWith("image/")) {
				event.preventDefault();
				const file = item.getAsFile();
				if (file) this.addImageFile(file);
			}
		}
	},

	handleDragOver(event) {
		if (!event.dataTransfer?.types?.includes("Files")) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
		if (this.dragLeaveTimeout) {
			clearTimeout(this.dragLeaveTimeout);
			this.dragLeaveTimeout = null;
		}
		this.isDraggingOver = true;
	},

	handleDragLeave(event) {
		event.preventDefault();
		if (this.dragLeaveTimeout) clearTimeout(this.dragLeaveTimeout);
		this.dragLeaveTimeout = setTimeout(() => {
			this.isDraggingOver = false;
			this.dragLeaveTimeout = null;
		}, 100);
	},

	handleDrop(event) {
		event.preventDefault();
		this.isDraggingOver = false;
		if (this.dragLeaveTimeout) {
			clearTimeout(this.dragLeaveTimeout);
			this.dragLeaveTimeout = null;
		}
		const files = event.dataTransfer?.files;
		if (!files) return;
		let addedAny = false;
		for (const file of files) {
			if (file.type.startsWith("image/")) {
				this.addImageFile(file);
				addedAny = true;
			}
		}
		if (addedAny) {
			this.$nextTick(() => {
				this.$refs.composerInput?.focus();
			});
		}
	},

	handleImageSelect(event) {
		const files = event.target.files;
		if (!files) return;
		for (const file of files) {
			if (file.type.startsWith("image/")) {
				this.addImageFile(file);
			}
		}
		event.target.value = "";
	},

	addImageFile(file) {
		const reader = new FileReader();
		reader.onload = () => {
			const dataUrl = reader.result;
			const base64 = dataUrl.split(",")[1];
			this.pendingImages.push({
				dataUrl,
				data: base64,
				mimeType: file.type,
				name: file.name,
			});
		};
		reader.readAsDataURL(file);
	},

	removeImage(index) {
		this.pendingImages.splice(index, 1);
	},

	isThreadNearBottom(threshold = 80) {
		const el = this.$refs.thread;
		if (!el) return true;
		const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		return distFromBottom <= threshold;
	},

	/**
	 * Attach wheel/touch listeners that detect user-initiated scroll-up
	 * immediately, bypassing the programmatic scroll guard. Called once
	 * during component init.
	 */
	setupScrollIntentDetection() {
		this.$nextTick(() => {
			const thread = this.$refs.thread;
			if (!thread) return;

			// Wheel: deltaY < 0 means scrolling up
			thread.addEventListener(
				"wheel",
				(e) => {
					if (e.deltaY < 0 && !this.isThreadNearBottom(80)) {
						this.userScrolledUp = true;
					}
				},
				{ passive: true },
			);

			// Touch: track start Y, set flag on upward swipe
			let touchStartY = null;
			thread.addEventListener(
				"touchstart",
				(e) => {
					touchStartY = e.touches[0]?.clientY ?? null;
				},
				{ passive: true },
			);
			thread.addEventListener(
				"touchmove",
				(e) => {
					if (touchStartY === null) return;
					const dy = (e.touches[0]?.clientY ?? 0) - touchStartY;
					// dy > 0 means finger moved down → content scrolls up
					if (dy > 10 && !this.isThreadNearBottom(80)) {
						this.userScrolledUp = true;
					}
				},
				{ passive: true },
			);
		});
	},

	handleThreadScroll() {
		const el = this.$refs.thread;
		if (!el) return;

		const prevTop = this._prevScrollTop;
		this._prevScrollTop = el.scrollTop;

		if (Date.now() < this._programmaticScrollUntil) return;

		const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		if (distFromBottom <= 80) {
			this.userScrolledUp = false;
			return;
		}

		if (typeof prevTop === "number" && el.scrollTop < prevTop - 10) {
			this.userScrolledUp = true;
		}
	},

	sendModifierKey(key) {
		const input = this.$refs.composerInput;
		if (!input) return;
		const opts = {
			key,
			code: key,
			bubbles: true,
			cancelable: true,
			ctrlKey: this.ctrlSticky,
		};
		input.dispatchEvent(new KeyboardEvent("keydown", opts));
		input.dispatchEvent(new KeyboardEvent("keyup", opts));
		if (this.ctrlSticky) {
			this.ctrlSticky = false;
		}
		input.focus();
	},

	toggleCtrlSticky() {
		this.ctrlSticky = !this.ctrlSticky;
	},
};
