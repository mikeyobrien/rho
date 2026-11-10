import { start } from "./app.js";

const SIDE = 2000; // the longest side a model is sent; the daemon scales to the same
/**
 * A photo small enough to send as it is, or a smaller JPEG of it. The browser's own decoder turns
 * it upright by its EXIF orientation. A GIF is left alone: a canvas would keep one frame of it.
 */
async function shrink(file) {
	if (file.type === "image/gif") return file;
	const bitmap = await createImageBitmap(file);
	try {
		const scale = Math.min(1, SIDE / Math.max(bitmap.width, bitmap.height));
		if (scale === 1 && file.size <= 1024 * 1024) return file;
		const canvas = Object.assign(document.createElement("canvas"), { width: Math.max(1, Math.round(bitmap.width * scale)), height: Math.max(1, Math.round(bitmap.height * scale)) });
		const draw = canvas.getContext("2d");
		draw.fillStyle = "#fff"; // a JPEG has no see-through: what was clear becomes white, not black
		draw.fillRect(0, 0, canvas.width, canvas.height);
		draw.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		const smaller = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
		return smaller && smaller.size < file.size ? smaller : file;
	} finally {
		bitmap.close();
	}
}

start({ document, storage: localStorage, location, history, fetch: (path, init) => fetch(path, init), touch: matchMedia("(pointer: coarse)").matches, shrink });
