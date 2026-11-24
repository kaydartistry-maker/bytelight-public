/** Keep semantic presets (not rounded pixel approximations such as 1536x658)
 * when adapting Studio dimensions to an image API's aspect-ratio control. */
export function studioImageAspect(size: string | undefined, pixels: string): string {
  const presets: Readonly<Record<string, string>> = {
    square: '1:1', portrait: '2:3', landscape: '3:2',
    '16:9': '16:9', '9:16': '9:16', '21:9': '21:9',
    '2:3': '2:3', '3:2': '3:2', '4:5': '4:5', '5:4': '5:4',
  };
  if (size && Object.hasOwn(presets, size)) return presets[size];
  const [width, height] = pixels.split('x').map(Number);
  if (![width, height].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Choose valid whole-pixel image dimensions.');
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}
