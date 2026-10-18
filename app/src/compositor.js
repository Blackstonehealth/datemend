// Browser-only photo overlay compositor (OffscreenCanvas). Decodes by content, so a WebP payload named
// ".png" works. The overlay is scaled to the main image's size when the two disagree.
export function browserCompositorAvailable() {
  return typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined';
}

export const browserCompositor = {
  async composite(mainBlob, overlayBlob, { quality = 0.95 } = {}) {
    const main = await createImageBitmap(mainBlob, { imageOrientation: 'from-image' });
    let overlay;
    try { overlay = await createImageBitmap(overlayBlob, { imageOrientation: 'from-image' }); }
    catch (e) { main.close(); throw new Error('overlay image could not be decoded'); }
    try {
      const canvas = new OffscreenCanvas(main.width, main.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(main, 0, 0);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(overlay, 0, 0, main.width, main.height);
      return await canvas.convertToBlob({ type: 'image/jpeg', quality });
    } finally { main.close(); overlay.close(); }
  },
};
