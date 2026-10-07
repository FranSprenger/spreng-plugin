// Header reader ported unchanged from the Spreng app at da08c160a. No pixel decode or image modification.
// image-dimensions.ts — pixel dimensions from an image's HEADER, and the OpenAI edit size they
// imply (lane P, doc 605, P4).
//
// WHY THIS EXISTS. `generate-photo-edit` sent `size: "auto"` to `/v1/images/edits` while stamping
// `aspect: "1:1"` on the creative provenance and dispatching the prompt FRAME with `aspect: "1:1"`
// — three places disagreeing about the same picture. A 9:16 story creative was edited at an
// unstated size and then recorded as square. Deriving all three from the source's real header
// makes them one fact instead of three guesses.
//
// Header parsing only: no decode, no allocation beyond the bytes handed in, no dependency. That
// matters because this runs inside the edit's own wall clock, on bytes the function already had.
const u16be = (b, at) => (b[at] << 8) | b[at + 1];
const u16le = (b, at) => b[at] | (b[at + 1] << 8);
const u32be = (b, at) => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
function startsWith(bytes, signature) {
    if (bytes.length < signature.length)
        return false;
    return signature.every((value, index) => bytes[index] === value);
}
function ascii(bytes, at, length) {
    let out = "";
    for (let i = at; i < at + length && i < bytes.length; i++) {
        out += String.fromCharCode(bytes[i]);
    }
    return out;
}
function pngDimensions(bytes) {
    // 8-byte signature, then the IHDR chunk: length(4) type(4) width(4) height(4).
    if (!startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
        return null;
    }
    if (bytes.length < 24 || ascii(bytes, 12, 4) !== "IHDR")
        return null;
    return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
}
function gifDimensions(bytes) {
    if (ascii(bytes, 0, 3) !== "GIF" || bytes.length < 10)
        return null;
    return { width: u16le(bytes, 6), height: u16le(bytes, 8) };
}
function webpDimensions(bytes) {
    if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") {
        return null;
    }
    const chunk = ascii(bytes, 12, 4);
    if (chunk === "VP8X" && bytes.length >= 30) {
        // 24-bit little-endian canvas width-1 / height-1.
        const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
        const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
        return { width, height };
    }
    if (chunk === "VP8 " && bytes.length >= 30) {
        // 3-byte frame tag, then the 3-byte sync code, then 14-bit dimensions.
        if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
            return null;
        }
        return {
            width: u16le(bytes, 26) & 0x3fff,
            height: u16le(bytes, 28) & 0x3fff,
        };
    }
    if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
        // 14 bits width-1 then 14 bits height-1, little-endian bit order.
        const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) |
            (bytes[24] << 24);
        return {
            width: 1 + (bits & 0x3fff),
            height: 1 + ((bits >>> 14) & 0x3fff),
        };
    }
    return null;
}
function jpegDimensions(bytes) {
    if (!startsWith(bytes, [0xff, 0xd8]))
        return null;
    let at = 2;
    while (at + 9 < bytes.length) {
        if (bytes[at] !== 0xff) {
            at++; // resync over padding
            continue;
        }
        const marker = bytes[at + 1];
        if (marker === 0xff) {
            at++;
            continue;
        }
        // Standalone markers carry no length.
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            at += 2;
            continue;
        }
        const length = u16be(bytes, at + 2);
        if (length < 2)
            return null;
        const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf &&
            marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isStartOfFrame) {
            if (at + 9 >= bytes.length)
                return null;
            // length(2) precision(1) height(2) width(2)
            return { height: u16be(bytes, at + 5), width: u16be(bytes, at + 7) };
        }
        at += 2 + length;
    }
    return null;
}
/** Dimensions from a PNG/JPEG/WebP/GIF header, or null when nothing readable is there. */
export function readImageDimensions(bytes) {
    if (!bytes || bytes.length < 10)
        return null;
    const found = pngDimensions(bytes) ?? gifDimensions(bytes) ??
        webpDimensions(bytes) ?? jpegDimensions(bytes);
    if (!found)
        return null;
    if (!Number.isFinite(found.width) || !Number.isFinite(found.height) ||
        found.width <= 0 || found.height <= 0) {
        return null;
    }
    return found;
}
