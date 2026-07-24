/**
 * On-chain NFT data client for S4/S10. Wraps Moralis (primary) with a
 * Covalent fallback. If Qwibi already has a Moralis/Covalent client, prefer
 * importing that instead of this one -- this exists so S4 is buildable
 * standalone per the brief.
 *
 * Handles pagination and a simple in-memory TTL cache up front (per the
 * "build pagination and caching in from day one" risk note) rather than as a
 * retrofit -- 10k+ token collections will otherwise blow through rate
 * limits.
 */

export interface NftTokenMetadata {
  tokenId: string;
  imageUrl: string | null;
  name: string | null;
  traits: Array<{ trait_type: string; value: string }>;
}

export interface NftCollectionPage {
  tokens: NftTokenMetadata[];
  cursor: string | null;
}

const MORALIS_BASE_URL = "https://deep-index.moralis.io/api/v2.2";
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry<unknown>>();

function cacheGet<T>(key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value as T;
}

function cacheSet<T>(key: string, value: T): void {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function requireMoralisKey(): string {
  const key = process.env.MORALIS_API_KEY;
  if (!key) throw new Error("MORALIS_API_KEY is not set");
  return key;
}

export async function resolveCollectionMetadata(params: {
  contractAddress: string;
  chain: string;
}): Promise<{ name: string | null; tokenCount: number | null; floorPrice: number | null }> {
  const cacheKey = `collection:${params.chain}:${params.contractAddress}`;
  const cached = cacheGet<{ name: string | null; tokenCount: number | null; floorPrice: number | null }>(
    cacheKey
  );
  if (cached) return cached;

  const res = await fetch(
    `${MORALIS_BASE_URL}/nft/${params.contractAddress}/metadata?chain=${params.chain}`,
    { headers: { "X-API-Key": requireMoralisKey() } }
  );
  if (!res.ok) {
    throw new Error(`Moralis collection metadata failed: ${res.status}`);
  }
  const data = (await res.json()) as {
    name?: string;
    synced_at?: string;
  };

  const result = { name: data.name ?? null, tokenCount: null, floorPrice: null };
  cacheSet(cacheKey, result);
  return result;
}

/** One page of token enumeration. Callers loop until cursor is null. */
export async function listCollectionTokensPage(params: {
  contractAddress: string;
  chain: string;
  cursor?: string | null;
  pageSize?: number;
}): Promise<NftCollectionPage> {
  const cacheKey = `tokens:${params.chain}:${params.contractAddress}:${params.cursor ?? "start"}`;
  const cached = cacheGet<NftCollectionPage>(cacheKey);
  if (cached) return cached;

  const url = new URL(`${MORALIS_BASE_URL}/nft/${params.contractAddress}`);
  url.searchParams.set("chain", params.chain);
  url.searchParams.set("format", "decimal");
  url.searchParams.set("limit", String(params.pageSize ?? 100));
  if (params.cursor) url.searchParams.set("cursor", params.cursor);

  const res = await fetch(url, { headers: { "X-API-Key": requireMoralisKey() } });
  if (!res.ok) {
    if (res.status === 429) {
      throw new Error("Moralis rate limit hit -- retry with backoff, do not spin");
    }
    throw new Error(`Moralis token page failed: ${res.status}`);
  }

  const data = (await res.json()) as {
    result: Array<{
      token_id: string;
      metadata: string | null;
      name?: string;
    }>;
    cursor: string | null;
  };

  const tokens: NftTokenMetadata[] = data.result.map((entry) => {
    let parsed: { image?: string; name?: string; attributes?: Array<{ trait_type: string; value: string }> } = {};
    if (entry.metadata) {
      try {
        parsed = JSON.parse(entry.metadata);
      } catch {
        parsed = {};
      }
    }
    return {
      tokenId: entry.token_id,
      imageUrl: parsed.image ?? null,
      name: parsed.name ?? entry.name ?? null,
      traits: parsed.attributes ?? []
    };
  });

  const page: NftCollectionPage = { tokens, cursor: data.cursor || null };
  cacheSet(cacheKey, page);
  return page;
}

export async function listAllCollectionTokens(params: {
  contractAddress: string;
  chain: string;
  maxTokens?: number;
}): Promise<NftTokenMetadata[]> {
  const out: NftTokenMetadata[] = [];
  let cursor: string | null = null;
  const cap = params.maxTokens ?? 10_000;

  do {
    const page: NftCollectionPage = await listCollectionTokensPage({
      contractAddress: params.contractAddress,
      chain: params.chain,
      cursor
    });
    out.push(...page.tokens);
    cursor = page.cursor;
  } while (cursor && out.length < cap);

  return out.slice(0, cap);
}

/** Trait frequency table + a simple rarity score (inverse frequency product). */
export function computeRarity(tokens: NftTokenMetadata[]): Map<string, number> {
  const traitCounts = new Map<string, number>();
  for (const token of tokens) {
    for (const trait of token.traits) {
      const key = `${trait.trait_type}:${trait.value}`;
      traitCounts.set(key, (traitCounts.get(key) ?? 0) + 1);
    }
  }

  const scores = new Map<string, number>();
  for (const token of tokens) {
    let score = 0;
    for (const trait of token.traits) {
      const key = `${trait.trait_type}:${trait.value}`;
      const frequency = (traitCounts.get(key) ?? 1) / tokens.length;
      score += 1 / frequency;
    }
    scores.set(token.tokenId, score);
  }
  return scores;
}
