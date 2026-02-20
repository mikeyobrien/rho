import * as primitives from "./constants-and-primitives.js";
import * as modelThinking from "./model-thinking-and-toast.js";
import * as renderingUsage from "./rendering-and-usage.js";
import * as toolSemantics from "./tool-semantics.js";

const { safeString, TOAST_LEVELS, TOAST_DEFAULT_DURATION } = {
	...primitives,
	...toolSemantics,
	...renderingUsage,
	...modelThinking,
};

export const rhoChatDialogAndFocusMethods = {
	submitEditorDialog() {
		if (!this.extensionDialog || this.extensionDialog.type !== "editor") {
			return;
		}
		this.sendExtensionUIResponse(
			this.extensionDialog.id,
			this.extensionDialog.editorContent,
		);
		this.closeDialog();
	},

	dismissDialog(value = null) {
		if (!this.extensionDialog) {
			return;
		}
		this.sendExtensionUIResponse(this.extensionDialog.id, value);
		this.closeDialog();
	},

	closeDialog() {
		if (this.extensionDialog?.timeoutId) {
			clearTimeout(this.extensionDialog.timeoutId);
		}
		this.extensionDialog = null;
	},

	sendExtensionUIResponse(id, value) {
		if (!this.activeRpcSessionId) {
			return;
		}
		this.sendWs({
			type: "extension_ui_response",
			sessionId: this.activeRpcSessionId,
			id,
			value,
		});
	},

	// Toast notifications

	showToast(message, level = "info", duration) {
		const id = ++this.toastIdCounter;
		const toast = {
			id,
			message,
			level,
			style: TOAST_LEVELS[level] ?? TOAST_LEVELS.info,
		};

		this.toasts.push(toast);

		const displayDuration = duration ?? TOAST_DEFAULT_DURATION;
		if (displayDuration > 0) {
			setTimeout(() => {
				this.removeToast(id);
			}, displayDuration);
		}
	},

	removeToast(id) {
		const idx = this.toasts.findIndex((t) => t.id === id);
		if (idx >= 0) {
			this.toasts.splice(idx, 1);
		}
	},

	// Widget display
	hasWidget() {
		return this.extensionWidget != null;
	},

	widgetContent() {
		if (!this.extensionWidget) {
			return "";
		}
		if (typeof this.extensionWidget === "string") {
			return this.extensionWidget;
		}
		return (
			this.extensionWidget.text ??
			this.extensionWidget.content ??
			safeString(this.extensionWidget)
		);
	},

	// Focus management
	shouldDismissKeyboardAfterSend() {
		if (
			typeof window === "undefined" ||
			typeof window.matchMedia !== "function"
		) {
			return false;
		}
		return (
			window.matchMedia("(max-width: 720px)").matches ||
			window.matchMedia("(pointer: coarse)").matches
		);
	},

	blurComposer() {
		const input = this.$refs.composerInput;
		if (input && typeof input.blur === "function") {
			input.blur();
		}
	},

	focusComposer() {
		this.$nextTick(() => {
			const input = this.$refs.composerInput;
			if (input && !input.disabled) {
				input.focus();
			}
		});
	},
};
