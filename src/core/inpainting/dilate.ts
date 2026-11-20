export function dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const result = new Uint8Array(mask.length);
  for (let index = 0; index < mask.length; index++) {
    if (!mask[index]) continue;
    const x = index % width, y = Math.floor(index / width);
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy > radius * radius || x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
        result[(y + dy) * width + x + dx] = 1;
      }
    }
  }
  return result;
}
