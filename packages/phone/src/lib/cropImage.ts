export const createImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image()
    image.addEventListener('load', () => resolve(image))
    image.addEventListener('error', (error) => reject(error))
    image.setAttribute('crossOrigin', 'anonymous')
    image.src = url
  })

export function getRadianAngle(degreeValue: number) {
  return (degreeValue * Math.PI) / 180
}

export default async function getCroppedImg(
  imageSrc: string,
  pixelCrop: { x: number; y: number; width: number; height: number },
  rotation = 0,
  flip = { horizontal: false, vertical: false },
  maxSize?: number
): Promise<string> {
  const image = await createImage(imageSrc)
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')

  if (!ctx) {
    return ''
  }

  // Round pixelCrop to avoid sub-pixel rendering blur
  const cropX = Math.round(pixelCrop.x)
  const cropY = Math.round(pixelCrop.y)
  const cropWidth = Math.round(pixelCrop.width)
  const cropHeight = Math.round(pixelCrop.height)

  // Set canvas size to the exact cropped size
  canvas.width = cropWidth
  canvas.height = cropHeight

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // Draw the cropped area directly from the original image
  ctx.drawImage(
    image,
    cropX,
    cropY,
    cropWidth,
    cropHeight,
    0,
    0,
    cropWidth,
    cropHeight
  )

  // To prevent mobile browsers from aggressively downsampling huge images
  // or hitting canvas size limits, we scale down if the crop is larger than the limit.
  const MAX_DIMENSION = maxSize || 2000;
  if (cropWidth > MAX_DIMENSION || cropHeight > MAX_DIMENSION) {
    const scale = Math.min(MAX_DIMENSION / cropWidth, MAX_DIMENSION / cropHeight);
    const scaledCanvas = document.createElement('canvas');
    scaledCanvas.width = Math.round(cropWidth * scale);
    scaledCanvas.height = Math.round(cropHeight * scale);
    const scaledCtx = scaledCanvas.getContext('2d');
    if (scaledCtx) {
      scaledCtx.imageSmoothingEnabled = true;
      scaledCtx.imageSmoothingQuality = 'high';
      scaledCtx.drawImage(canvas, 0, 0, scaledCanvas.width, scaledCanvas.height);
      return scaledCanvas.toDataURL('image/webp', 0.9) || scaledCanvas.toDataURL('image/png');
    }
  }

  return canvas.toDataURL('image/webp', 0.9) || canvas.toDataURL('image/png');
}
