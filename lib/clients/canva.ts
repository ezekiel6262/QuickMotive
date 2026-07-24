/**
 * Server-side client for Canva's Connect API, covering the subset of
 * operations S3 (design tweak) needs: import an existing design, apply a
 * bounded set of edit operations, and export the result.
 *
 * KNOWN GAP: the transaction flow described in the build brief
 * (start-editing-transaction / perform-editing-operations /
 * commit-editing-transaction) does not match Canva's actual MCP tool
 * surface. The real tool is a single `edit-design` call keyed by a
 * `transaction_id` obtained from `read-design(open_transaction: true)`, with
 * a `finalize` field ("keep_open" | "commit" | "cancel"). This client models
 * that real shape. Confirm auth scope requirements (design:content:write,
 * design:meta:read, asset:write) against Canva's Connect API docs before
 * go-live -- see README "Known integration gaps".
 */

const CANVA_BASE_URL = process.env.CANVA_MCP_URL ?? "https://api.canva.com/rest/v1";

function requireAccessToken(): string {
  const token = process.env.CANVA_ACCESS_TOKEN;
  if (!token) throw new Error("CANVA_ACCESS_TOKEN is not set");
  return token;
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${CANVA_BASE_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${requireAccessToken()}`,
      ...init.headers
    }
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Canva ${path} failed: ${res.status} ${body}`);
  }

  return (await res.json()) as T;
}

export type EditOperation =
  | { type: "replace_text"; element_id: string; text: string }
  | { type: "find_and_replace_text"; element_id: string; find_text: string; replace_text: string }
  | { type: "recolor_element"; element_id: string; color: string }
  | { type: "resize_element"; element_id: string; width?: number; height?: number; preserve_aspect_ratio?: boolean }
  | { type: "position_element"; element_id: string; top: number; left: number }
  | { type: "update_fill"; element_id: string; asset_type: "image" | "video"; asset_id: string; alt_text: string };

export interface DesignDocument {
  design_id: string;
  transaction_id: string;
  pages: Array<{
    page_index: number;
    is_editable: boolean;
    is_empty: boolean;
    is_responsive: boolean;
    elements: Array<{ id: string; type: string }>;
  }>;
}

export async function readDesign(designId: string): Promise<DesignDocument> {
  return request<DesignDocument>(`/designs/${designId}?open_transaction=true`, { method: "GET" });
}

export async function importDesignFromUrl(params: {
  url: string;
  name: string;
  intendedDesignType?: string;
}): Promise<{ design_id: string }> {
  return request("/designs/import", {
    method: "POST",
    body: JSON.stringify({
      url: params.url,
      name: params.name,
      intended_design_type: params.intendedDesignType
    })
  });
}

export async function uploadAssetFromUrl(params: {
  url: string;
  name: string;
}): Promise<{ asset_id: string }> {
  return request("/assets/import", {
    method: "POST",
    body: JSON.stringify({ url: params.url, name: params.name })
  });
}

/** Applies operations to a single page and leaves the transaction open. */
export async function applyEditOperations(params: {
  transactionId: string;
  pageIndex: number;
  operations: EditOperation[];
}): Promise<{ status: "edits_unverified"; after_thumbnail_url: string }> {
  return request(`/designs/edit`, {
    method: "POST",
    body: JSON.stringify({
      transaction_id: params.transactionId,
      page_index: params.pageIndex,
      operations: params.operations,
      finalize: "keep_open"
    })
  });
}

export async function commitTransaction(transactionId: string): Promise<{ status: "committed" }> {
  return request(`/designs/edit`, {
    method: "POST",
    body: JSON.stringify({ transaction_id: transactionId, operations: [], finalize: "commit" })
  });
}

export async function cancelTransaction(transactionId: string): Promise<{ status: "cancelled" }> {
  return request(`/designs/edit`, {
    method: "POST",
    body: JSON.stringify({ transaction_id: transactionId, operations: [], finalize: "cancel" })
  });
}

export async function exportDesign(params: {
  designId: string;
  format: { type: "png" | "pdf" | "jpg"; export_quality?: "regular" | "pro" };
}): Promise<{ export_url: string }> {
  return request(`/designs/${params.designId}/export`, {
    method: "POST",
    body: JSON.stringify({ format: params.format })
  });
}

export async function listBrandKits(): Promise<
  Array<{ id: string; name: string; thumbnail_url?: string }>
> {
  return request(`/brand-kits`, { method: "GET" });
}
