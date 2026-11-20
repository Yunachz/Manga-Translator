import { sha256 } from '../cache/identity';
import { readLocalBlob } from '../image/LocalImage';

/** Compare a rendered MangaDex blob to the exact source used to render a chapter patch. */
export async function readerImageDigest(src: string): Promise<string | undefined> {
  const blob = await readLocalBlob(src);
  if (blob) return sha256(await blob.arrayBuffer());
}
