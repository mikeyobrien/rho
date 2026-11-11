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

const u32 = (bytes: Uint8Array, at: number, little = false): number => (little ? bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24) : (bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
const tag = (bytes: Uint8Array, at: number): string => String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
/**
 * The picture without what a camera or an editor wrote beside it: where and when it was taken,
 * the device, comments. The pixels are not touched and nothing is decoded. A file that does not
 * read as its format says is returned as it is; so is a GIF.
 */
export function stripMetadata(bytes: Uint8Array, mimeType: string): Uint8Array {
	try {
		const kept: Uint8Array[] = [];
		if (mimeType === "image/jpeg") {
			// Segments up to the picture data. Dropped: APP1 (Exif, XMP), APP13 (IPTC), comments.
			let at = 2;
			kept.push(bytes.subarray(0, 2));
			while (at + 4 <= bytes.length) {
				if (bytes[at] !== 0xff) return bytes;
				const marker = bytes[at + 1]!;
				if (marker === 0xda) return Buffer.concat([...kept, bytes.subarray(at)]); // the picture itself, to the end
				const end = at + 2 + ((bytes[at + 2]! << 8) | bytes[at + 3]!);
				if (end > bytes.length || end < at + 4) return bytes;
				if (marker !== 0xe1 && marker !== 0xed && marker !== 0xfe) kept.push(bytes.subarray(at, end));
				at = end;
			}
			return bytes;
		}
		if (mimeType === "image/png") {
			let at = 8;
			kept.push(bytes.subarray(0, 8));
			while (at + 12 <= bytes.length) {
				const end = at + 12 + u32(bytes, at);
				if (end > bytes.length) return bytes;
				if (!["eXIf", "tEXt", "zTXt", "iTXt", "tIME"].includes(tag(bytes, at + 4))) kept.push(bytes.subarray(at, end));
				at = end;
			}
			return at === bytes.length ? Buffer.concat(kept) : bytes;
		}
		if (mimeType === "image/webp") {
			let at = 12;
			const chunks: Uint8Array[] = [];
			while (at + 8 <= bytes.length) {
				const size = u32(bytes, at + 4, true);
				const end = at + 8 + size + (size & 1); // chunks are padded to an even length
				if (end > bytes.length + 1) return bytes;
				const name = tag(bytes, at);
				if (name === "VP8X") {
					const header = Uint8Array.from(bytes.subarray(at, Math.min(end, bytes.length)));
					header[8] = header[8]! & ~0x0c; // the flags that say "Exif inside" and "XMP inside"
					chunks.push(header);
				} else if (name !== "EXIF" && name !== "XMP ") chunks.push(bytes.subarray(at, Math.min(end, bytes.length)));
				at = end;
			}
			const body = Buffer.concat(chunks);
			const head = Buffer.from(bytes.subarray(0, 12));
			head.writeUInt32LE(body.length + 4, 4);
			return Buffer.concat([head, body]);
		}
	} catch {
		// not what it claims to be: sent as it is, or refused by whoever decodes it
	}
	return bytes;
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
			// What the processor returns is upright. One it did not need to change still carries its
			// metadata, a camera's place and time among it: that is taken off before it is stored or sent.
			taken.push({ type: "image", data: Buffer.from(stripMetadata(new Uint8Array(Buffer.from(ready.data, "base64")), ready.mimeType)).toString("base64"), mimeType: ready.mimeType });
		} else {
			// Nothing here can scale it, so it goes as it is or not at all.
			if (data.length > DEFAULT_IMAGE_LIMITS.maxBytes) throw new PhotoRefused(`${which} is too large to send as it is, and this rho cannot make pictures smaller.`);
			// Nothing here can turn it either, and a photo's metadata may say "shown rotated": taking
			// that off would lay it on its side. So with no processor a photo keeps its metadata.
			taken.push({ type: "image", data, mimeType });
		}
	}
	return taken;
}
