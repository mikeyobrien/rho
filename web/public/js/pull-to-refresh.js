/**
 * Page-level pull-to-refresh for standalone PWA.
 *
 * Listens on the window for touch gestures. Activates when no ancestor
 * scroller has room to scroll up (i.e. every scroller the finger is
 * inside is already at scrollTop ≈ 0).
 *
 * Usage:
 *   const ptr = new PullToRefresh(containerEl, {
 *     onRefresh: async () => { ... },
 *     threshold: 80,         // px to pull before triggering
 *     maxPull: 120,          // max visual displacement
 *   });
 *   ptr.destroy();           // cleanup
 *
 * Inserts a small indicator element at the top of containerEl.
 * Works on touch devices only.
 */
class PullToRefresh {
	constructor(el, opts = {}) {
		this.el = el;
		this.onRefresh = opts.onRefresh || (() => Promise.resolve());
		this.threshold = opts.threshold || 80;
		this.maxPull = opts.maxPull || 120;

		this._startY = 0;
		this._pulling = false;
		this._refreshing = false;
		this._pullDistance = 0;

		// Create indicator — prepend to container
		this._indicator = document.createElement("div");
		this._indicator.className = "ptr-indicator";
		this._indicator.innerHTML =
			'<span class="ptr-arrow">↓</span><span class="ptr-text">pull to refresh</span>';
		el.prepend(this._indicator);

		// Bind handlers to window (page-level gesture)
		this._onTouchStart = this._onTouchStart.bind(this);
		this._onTouchMove = this._onTouchMove.bind(this);
		this._onTouchEnd = this._onTouchEnd.bind(this);

		window.addEventListener("touchstart", this._onTouchStart, {
			passive: true,
		});
		window.addEventListener("touchmove", this._onTouchMove, {
			passive: false,
		});
		window.addEventListener("touchend", this._onTouchEnd, { passive: true });
	}

	/**
	 * Walk from the touch target up to the document. If any scrollable
	 * ancestor has scrollTop > 5 (small tolerance), the page is not
	 * "at top" and pull-to-refresh should not activate.
	 */
	_isAtPageTop(target) {
		let node = target;
		while (node && node !== document.documentElement) {
			if (node.scrollHeight > node.clientHeight + 1 && node.scrollTop > 5) {
				return false;
			}
			node = node.parentElement;
		}
		return window.scrollY <= 5;
	}

	_onTouchStart(e) {
		if (this._refreshing) return;
		if (!this._isAtPageTop(e.target)) return;
		this._startY = e.touches[0].clientY;
		this._pulling = true;
		this._pullDistance = 0;
	}

	_onTouchMove(e) {
		if (!this._pulling) return;

		const currentY = e.touches[0].clientY;
		const delta = currentY - this._startY;

		// Not pulling down — abort
		if (delta <= 0) {
			this._pullDistance = 0;
			this._updateIndicator();
			return;
		}

		// Prevent native scroll while we handle the gesture
		e.preventDefault();

		// Rubber-band: diminishing returns past threshold
		this._pullDistance = Math.min(
			this.maxPull,
			delta < this.threshold
				? delta
				: this.threshold + (delta - this.threshold) * 0.3,
		);

		this._updateIndicator();
	}

	_onTouchEnd() {
		if (!this._pulling) return;
		this._pulling = false;

		if (this._pullDistance >= this.threshold) {
			this._triggerRefresh();
		} else {
			this._reset();
		}
	}

	_updateIndicator() {
		const progress = Math.min(1, this._pullDistance / this.threshold);
		const height = this._pullDistance;

		this._indicator.style.height = height + "px";
		this._indicator.style.opacity = progress;

		const arrow = this._indicator.querySelector(".ptr-arrow");
		const text = this._indicator.querySelector(".ptr-text");

		if (this._refreshing) {
			arrow.textContent = "⟳";
			arrow.classList.add("ptr-spinning");
			text.textContent = "refreshing…";
		} else if (progress >= 1) {
			arrow.textContent = "↑";
			arrow.classList.remove("ptr-spinning");
			text.textContent = "release to refresh";
		} else {
			arrow.textContent = "↓";
			arrow.classList.remove("ptr-spinning");
			text.textContent = "pull to refresh";
		}
	}

	async _triggerRefresh() {
		this._refreshing = true;
		this._pullDistance = this.threshold * 0.6;
		this._updateIndicator();

		try {
			await this.onRefresh();
		} catch (err) {
			console.warn("Pull-to-refresh callback error:", err);
		} finally {
			this._refreshing = false;
			this._reset();
		}
	}

	_reset() {
		this._pullDistance = 0;
		this._indicator.style.height = "0px";
		this._indicator.style.opacity = "0";
		const arrow = this._indicator.querySelector(".ptr-arrow");
		arrow.classList.remove("ptr-spinning");
	}

	destroy() {
		window.removeEventListener("touchstart", this._onTouchStart);
		window.removeEventListener("touchmove", this._onTouchMove);
		window.removeEventListener("touchend", this._onTouchEnd);
		this._indicator.remove();
	}
}

// Expose globally
window.PullToRefresh = PullToRefresh;
