export function bindTerminalTouchScroll({
	surfaceEl,
	getTerm,
	getRows,
	focus,
	dragThresholdPx = 6,
}) {
	if (!surfaceEl || surfaceEl.dataset.rhoTouchScrollBound === "1") {
		return;
	}
	surfaceEl.dataset.rhoTouchScrollBound = "1";

	let tracking = false;
	let dragging = false;
	let startY = 0;
	let lastY = 0;
	let carry = 0;

	const rowHeight = () => {
		const rows = Math.max(1, Number(getRows?.()) || 1);
		const height = Math.max(1, Number(surfaceEl.clientHeight) || 1);
		return Math.max(1, height / rows);
	};

	const reset = () => {
		tracking = false;
		dragging = false;
		carry = 0;
	};

	surfaceEl.addEventListener(
		"touchstart",
		(event) => {
			if (event.touches.length !== 1) {
				reset();
				return;
			}
			tracking = true;
			dragging = false;
			startY = event.touches[0].clientY;
			lastY = startY;
			carry = 0;
		},
		{ passive: true },
	);

	surfaceEl.addEventListener(
		"touchmove",
		(event) => {
			if (!tracking || event.touches.length !== 1) {
				return;
			}
			const term = getTerm?.();
			if (!term?.scrollLines) {
				return;
			}

			const currentY = event.touches[0].clientY;
			const totalDelta = currentY - startY;
			if (!dragging && Math.abs(totalDelta) < dragThresholdPx) {
				lastY = currentY;
				return;
			}

			dragging = true;
			event.preventDefault();
			const delta = currentY - lastY;
			lastY = currentY;
			carry += delta / rowHeight();
			const wholeLines = carry > 0 ? Math.floor(carry) : Math.ceil(carry);
			if (!wholeLines) {
				return;
			}
			carry -= wholeLines;
			term.scrollLines(-wholeLines);
		},
		{ passive: false },
	);

	const finish = () => {
		if (tracking && !dragging) {
			focus?.();
		}
		reset();
	};

	surfaceEl.addEventListener("touchend", finish, { passive: true });
	surfaceEl.addEventListener("touchcancel", finish, { passive: true });
}
