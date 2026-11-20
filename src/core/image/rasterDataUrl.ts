export function rasterBlob(url: string, limit = 14_000_000): Blob {
  const header = /^data:(image\/(?:png|webp));base64,/.exec(url);
  if (!header || url.length > limit + header[0].length) throw new Error('Invalid raster data');
  const binary = atob(url.slice(header[0].length));
  return new Blob([Uint8Array.from(binary, character => character.charCodeAt(0))], { type: header[1] });
}
