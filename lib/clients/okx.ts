import { createHmac } from "node:crypto";

/**
 * Signed client for OKX's v5 exchange API (docs.okx.com/docs-v5), used here
 * to confirm settlement currency/payout wallet health -- not for trading.
 * Auth: OK-ACCESS-KEY / OK-ACCESS-SIGN / OK-ACCESS-TIMESTAMP /
 * OK-ACCESS-PASSPHRASE headers, where the signature is
 * base64(hmacSha256(secret, timestamp + method + requestPath + body)) and
 * timestamp is ISO 8601 with millisecond precision (server rejects requests
 * more than 30s off, in UTC).
 */

const OKX_BASE_URL = "https://www.okx.com";

function requireEnv(name: "OKX_API_KEY" | "OKX_SECRET_KEY" | "OKX_PASSPHRASE"): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function sign(timestamp: string, method: string, requestPath: string, body: string): string {
  const secret = requireEnv("OKX_SECRET_KEY");
  const preHash = `${timestamp}${method}${requestPath}${body}`;
  return createHmac("sha256", secret).update(preHash).digest("base64");
}

async function signedRequest<T>(method: "GET" | "POST", requestPath: string): Promise<T> {
  const timestamp = new Date().toISOString();
  const body = "";
  const signature = sign(timestamp, method, requestPath, body);

  const res = await fetch(`${OKX_BASE_URL}${requestPath}`, {
    method,
    headers: {
      "OK-ACCESS-KEY": requireEnv("OKX_API_KEY"),
      "OK-ACCESS-SIGN": signature,
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": requireEnv("OKX_PASSPHRASE"),
      "Content-Type": "application/json"
    }
  });

  const json = (await res.json()) as { code: string; msg: string; data: unknown };
  if (!res.ok || json.code !== "0") {
    throw new Error(`OKX ${requestPath} failed: ${json.code} ${json.msg}`);
  }
  return json.data as T;
}

export interface OkxBalanceDetail {
  ccy: string;
  availBal: string;
  bal: string;
  frozenBal: string;
}

interface OkxAccountBalanceResponse {
  totalEq: string;
  details: OkxBalanceDetail[];
}

/**
 * Fetches the trading account balance, optionally filtered to a single
 * currency (e.g. the configured settlement currency). Used to confirm the
 * payout wallet actually holds/received the expected settlement currency --
 * see build brief's OKX.ai integration checklist item "Confirm settlement
 * currency ... and payout wallet."
 */
export async function getAccountBalance(ccy?: string): Promise<OkxBalanceDetail[]> {
  const path = ccy ? `/api/v5/account/balance?ccy=${encodeURIComponent(ccy)}` : "/api/v5/account/balance";
  const data = await signedRequest<OkxAccountBalanceResponse[]>("GET", path);
  return data[0]?.details ?? [];
}
