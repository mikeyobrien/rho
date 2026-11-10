// Photos the person sends with a message. What arrives is checked as bytes, not by the name or
// type it was given, and made to fit what a model takes. Nothing here touches a file: a photo
// lives in the conversation's entry, like the words beside it.
import type { ImageContent } from "@earendil-works/pi-ai";
import { DEFAULT_IMAGE_LIMITS, type ImageProcessor } from "@earendil-works/pi-durable/tools";

export const MAX_PHOTOS = 4;
/** The largest file taken, before it is scaled. A phone's camera photo is 2 to 8 MB. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
/** A photo that is not taken, in words for the person. */
export class PhotoRefused extends Error {}

const starts = (bytes: Uint8Array, at: number, text: string): boolean => [...text].every((letter, index) => bytes[at + index] === letter.charCodeAt(0));
/** The format the bytes are in, when it is one every provider takes; what the sender called it is not asked. */
export function photoType(bytes: Uint8Array): string | undefined {
	if (bytes[0] === 0x89 && starts(bytes, 1, "PNG\r\n\x1a\n")) return "image/png";
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (starts(bytes, 0, "GIF87a") || starts(bytes, 0, "GIF89a")) return "image/gif";
	if (starts(bytes, 0, "RIFF") && starts(bytes, 8, "WEBP")) return "image/webp";
	return undefined;
}

/**
 * The photos of one message, ready for the model. `given` is what the client sent:
 * `[{ data: <base64> }]`. With a processor a large photo is scaled; without one it is refused.
 */
export async function takePhotos(given: unknown, images?: ImageProcessor): Promise<ImageContent[]> {
	if (!Array.isArray(given) || given.length < 1 || given.length > MAX_PHOTOS) throw new PhotoRefused(`Send one to ${MAX_PHOTOS} photos with a message.`);
	const taken: ImageContent[] = [];
	for (const [index, item] of given.entries()) {
		const which = given.length === 1 ? "That photo" : `Photo ${index + 1}`;
		const data = (item as { data?: unknown } | null)?.data;
		if (typeof data !== "string" || data === "" || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new PhotoRefused(`${which} did not arrive whole. Try it again.`);
		if (data.length > Math.ceil(MAX_PHOTO_BYTES / 3) * 4) throw new PhotoRefused(`${which} is too large: the most is ${MAX_PHOTO_BYTES / 1024 / 1024} MB.`);
		const bytes = new Uint8Array(Buffer.from(data, "base64"));
		const mimeType = photoType(bytes);
		if (!mimeType) throw new PhotoRefused(`${which} is not a JPEG, PNG, GIF or WebP picture.`);
		if (images) {
			const ready = await images.prepare(bytes, mimeType, DEFAULT_IMAGE_LIMITS);
			if (!ready) throw new PhotoRefused(`${which} could not be read as a picture.`);
			taken.push({ type: "image", data: ready.data, mimeType: ready.mimeType });
		} else {
			// Nothing here can scale it, so it goes as it is or not at all.
			if (data.length > DEFAULT_IMAGE_LIMITS.maxBytes) throw new PhotoRefused(`${which} is too large to send as it is, and this rho cannot make pictures smaller.`);
			taken.push({ type: "image", data, mimeType });
		}
	}
	return taken;
}
