// Shrinks phone photos before upload: smaller transfer and fewer image tokens for the agent.
const MAX_EDGE = 2048
const JPEG_QUALITY = 0.85

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('could not encode image'))), type, quality),
  )
}

/**
 * Returns an upload-ready image. PNG/WebP/GIF within the size limit pass through untouched
 * (screenshots stay lossless); anything larger, or any other format the browser can decode
 * (camera JPEGs, HEIC on browsers that decode it), is redrawn at most 2048px on its long edge.
 */
export async function prepareImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file).catch(() => null)
  if (!bitmap) throw new Error('This image format can’t be read here — try JPEG or PNG')

  const longEdge = Math.max(bitmap.width, bitmap.height)
  const passthrough = ['image/png', 'image/webp', 'image/gif'].includes(file.type)
  if (passthrough && longEdge <= MAX_EDGE) {
    bitmap.close()
    return file
  }

  const scale = Math.min(1, MAX_EDGE / longEdge)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  // Keep PNG for screenshots (sharp text); photos become JPEG.
  return file.type === 'image/png' ? toBlob(canvas, 'image/png') : toBlob(canvas, 'image/jpeg', JPEG_QUALITY)
}
