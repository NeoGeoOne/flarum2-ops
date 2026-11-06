/**
 * Local pre-checks for Flarum 2 image uploads (AbstractImageValidator):
 * max 2048 KB, max 24 megapixels, MIME jpeg/png/bmp/gif/webp. SVG and ICO are
 * not accepted. Detects the real type from magic bytes (not the extension) and
 * reads dimensions from the header so bad files fail before the request.
 */

export const MAX_UPLOAD_BYTES = 2048 * 1024;
export const MAX_MEGAPIXELS = 24;

export interface ImageInfo {
  mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/bmp";
  ext: string;
  width?: number;
  height?: number;
}

export function sniffImage(buf: Uint8Array): ImageInfo | undefined {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) {
    return { mime: "image/png", ext: "png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 10 && b.toString("ascii", 0, 3) === "GIF") {
    return { mime: "image/gif", ext: "gif", width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  }
  if (b.length >= 26 && b.toString("ascii", 0, 2) === "BM") {
    return { mime: "image/bmp", ext: "bmp", width: b.readInt32LE(18), height: Math.abs(b.readInt32LE(22)) };
  }
  if (b.length >= 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const chunk = b.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { mime: "image/webp", ext: "webp", width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (chunk === "VP8 ") return { mime: "image/webp", ext: "webp", width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = b.readUInt32LE(21);
      return { mime: "image/webp", ext: "webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return { mime: "image/webp", ext: "webp" };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // Walk JPEG segments to the first SOFn marker.
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { mime: "image/jpeg", ext: "jpg", height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
    return { mime: "image/jpeg", ext: "jpg" };
  }
  return undefined;
}

export function checkUpload(buf: Uint8Array, name: string): { info: ImageInfo; warnings: string[] } {
  if (buf.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error(`${name} is ${(buf.byteLength / 1024).toFixed(0)} KB; Flarum accepts at most 2048 KB.`);
  }
  const info = sniffImage(buf);
  if (!info) {
    const head = Buffer.from(buf.slice(0, 64)).toString("utf8");
    if (/<svg|<\?xml/i.test(head)) throw new Error(`${name} is SVG; Flarum 2 uploads accept only jpeg, png, gif, webp or bmp. Export a PNG/WebP.`);
    throw new Error(`${name} is not a jpeg/png/gif/webp/bmp image (ICO is not accepted either).`);
  }
  const warnings: string[] = [];
  if (info.width && info.height && (info.width * info.height) / 1e6 > MAX_MEGAPIXELS) {
    throw new Error(`${name} is ${info.width}x${info.height} (> ${MAX_MEGAPIXELS} MP); Flarum rejects it.`);
  }
  return { info, warnings };
}

/** Kind-specific advice (Flarum resizes: logos to 60 px high WebP, favicon to 64x64 PNG). */
export function kindAdvice(kind: string, info: ImageInfo): string[] {
  const w: string[] = [];
  if ((kind === "logo" || kind === "logo_dark_mode") && info.height && info.height < 120) {
    w.push(`logo is ${info.height}px high; Flarum scales logos to 60px high (upscaling small images), so ≥120px keeps it sharp on HiDPI.`);
  }
  if (kind === "favicon" && info.width && info.height && info.width !== info.height) {
    w.push(`favicon is ${info.width}x${info.height}; Flarum scales it to fit 64x64 keeping the aspect ratio, so it will not be square.`);
  }
  return w;
}
