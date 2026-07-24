import sharp from "sharp";

/** 8x8 grayscale average hash -> 64-bit similarity fingerprint. */
async function averageHash(url: string): Promise<bigint> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Failed to fetch image for hashing: ${url} (${res.status}) ${body}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());

  const { data } = await sharp(buffer)
    .resize(8, 8, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const avg = data.reduce((sum, v) => sum + v, 0) / data.length;
  let hash = 0n;
  for (let i = 0; i < data.length; i++) {
    hash = (hash << 1n) | (data[i]! >= avg ? 1n : 0n);
  }
  return hash;
}

function hammingDistance(a: bigint, b: bigint): number {
  let xor = a ^ b;
  let distance = 0;
  while (xor > 0n) {
    distance += Number(xor & 1n);
    xor >>= 1n;
  }
  return distance;
}

/** Returns a 0-1 similarity score (1 = identical) between two images via perceptual hash. */
export async function similarityScore(urlA: string, urlB: string): Promise<number> {
  const [hashA, hashB] = await Promise.all([averageHash(urlA), averageHash(urlB)]);
  const distance = hammingDistance(hashA, hashB);
  return 1 - distance / 64;
}
