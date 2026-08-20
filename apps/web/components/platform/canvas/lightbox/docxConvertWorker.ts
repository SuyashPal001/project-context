/// <reference lib="webworker" />

// Runs mammoth's DOCX→HTML conversion off the main thread, so a large .docx
// doesn't freeze the tab — see DocxPreview.tsx.
//
// mammoth's default image handling (images.dataUri) base64-inlines each
// embedded image at its original resolution. For image-heavy documents this,
// not the text/XML parsing, is the dominant cost: a handful of full-res
// screenshots easily accounts for most of an 18MB .docx and blows up the
// resulting HTML string to match. We swap in a custom image converter that
// downscales/recompresses each image via OffscreenCanvas before it's
// embedded — this only touches image bytes, not text/paragraph/heading/list
// conversion, so mammoth's (already limited, style-mapped) text styling is
// unaffected.
import * as mammoth from 'mammoth';

const MAX_IMAGE_DIMENSION = 1200;
const JPEG_QUALITY = 0.7;

async function arrayBufferToBase64(buffer: ArrayBuffer): Promise<string> {
  const blob = new Blob([buffer]);
  const dataUrl: string = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

async function compressImage(buffer: ArrayBuffer, contentType: string): Promise<{ src: string }> {
  try {
    const bitmap = await createImageBitmap(new Blob([buffer], { type: contentType }));
    const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
    const base64 = await arrayBufferToBase64(await blob.arrayBuffer());
    return { src: `data:image/jpeg;base64,${base64}` };
  } catch {
    // Non-rasterizable or unsupported source (e.g. an embedded EMF/WMF) —
    // fall back to the original bytes uncompressed rather than dropping it.
    const base64 = await arrayBufferToBase64(buffer);
    return { src: `data:${contentType};base64,${base64}` };
  }
}

self.onmessage = async (event: MessageEvent<ArrayBuffer>) => {
  try {
    const result = await mammoth.convertToHtml(
      { arrayBuffer: event.data },
      {
        convertImage: mammoth.images.imgElement((element) =>
          element.readAsArrayBuffer().then((buffer: ArrayBuffer) => compressImage(buffer, element.contentType))
        ),
      }
    );
    self.postMessage({ html: result.value });
  } catch {
    self.postMessage({ error: true });
  }
};
