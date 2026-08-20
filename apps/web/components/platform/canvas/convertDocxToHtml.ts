// Shared by KnowledgeBaseSection.tsx and lightbox/DocxPreview.tsx — spins up
// docxConvertWorker.ts (mammoth conversion + image downscaling, off the main
// thread) and returns the resulting HTML. See docxConvertWorker.ts for why:
// a large, image-heavy .docx is slow enough to freeze the tab if converted
// inline on the main thread.
export function convertDocxToHtml(arrayBuffer: ArrayBuffer): { promise: Promise<string>; cancel: () => void } {
  const worker = new Worker(new URL('./lightbox/docxConvertWorker.ts', import.meta.url));
  const promise = new Promise<string>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<{ html?: string; error?: boolean }>) => {
      worker.terminate();
      if (event.data.error || typeof event.data.html !== 'string') {
        reject(new Error('docx conversion failed'));
      } else {
        resolve(event.data.html);
      }
    };
    worker.onerror = () => {
      worker.terminate();
      reject(new Error('docx worker error'));
    };
  });
  worker.postMessage(arrayBuffer, [arrayBuffer]);
  return { promise, cancel: () => worker.terminate() };
}
