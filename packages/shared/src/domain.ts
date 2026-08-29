// Canonical domain types. Vocabulary is defined in /CONTEXT.md — the names here
// must never drift from the glossary.

export type Channel = "push" | "pull" | "sftp" | "scrape";
export type SnapshotFormat = "xml" | "ndjson";

export type RunState =
  | "pending"
  | "downloading"
  | "staging"
  | "validating"
  | "awaiting_review"
  | "merging"
  | "done"
  | "failed"
  | "superseded";

export type IssueScope = "record" | "product" | "run";
export type IssueStatus = "open" | "resolved";

export interface FeedThresholds {
  /** Halt when product count drops more than this fraction vs last successful Run. */
  maxCountDrop: number;
  /** Halt when the Missing set exceeds this fraction of the previous catalog. */
  maxMissingSet: number;
  /** Halt when Skipped records exceed this fraction of total records. */
  maxErrorRate: number;
}

export const DEFAULT_THRESHOLDS: FeedThresholds = {
  maxCountDrop: 0.2,
  maxMissingSet: 0.05,
  maxErrorRate: 0.02,
};

/** Per-Feed config (thresholds attach to the Feed, not the Supplier — CONTEXT.md). */
export interface FeedConfig {
  id: string;
  supplierId: string;
  channel: Channel;
  format: SnapshotFormat;
  thresholds: FeedThresholds;
  /** Consecutive Skipped Runs before a Product Issue is raised. */
  skipStreakLimit: number;
}

/** An image as delivered by the Snapshot. cdn_url is filled by the future rehost pipeline. */
export interface ProductImage {
  source_url: string;
  cdn_url: string | null;
  fetched_at: string | null;
}

/**
 * The sellable unit. "SKU" refers to a Variant and nothing else.
 * A Product whose record declares no variants gets one implicit default Variant.
 */
export interface Variant {
  sku: string;
  gtin: string | null;
  price: string | null;
  currency: string | null;
  stock: number | null;
  attributes: Record<string, string>;
  isDefault?: boolean;
}

/** One normalized product record produced by a Feed transform. */
export interface NormalizedProduct {
  productCode: string;
  title: string;
  description: string | null;
  brand: string | null;
  /** Product-level GTIN is only a fallback; GTIN properly lives on the Variant. */
  gtin: string | null;
  variants: Variant[];
  images: ProductImage[];
  attributes: Record<string, string>;
}

/** A record that was present in the Snapshot but failed validation → Skipped, not Missing. */
export interface SkippedRecord {
  productCode: string | null;
  reason: string;
  rawFragment: string;
}

export type TransformResult =
  | { ok: true; product: NormalizedProduct }
  | { ok: false; skipped: SkippedRecord };

/**
 * A Feed transform: the only per-supplier code. Receives one raw record node
 * (already isolated by the streaming front-end) and returns a normalized
 * product or a skip verdict. ~50-100 lines per supplier, fixture-tested.
 */
export interface FeedTransform {
  /** XML element name (or NDJSON discriminator) that delimits one product record. */
  recordElement: string;
  transform(node: RawRecord): TransformResult;
}

/** A parsed record node handed to transforms: element tree flattened to a lightweight shape. */
export interface RawRecord {
  name: string;
  attributes: Record<string, string>;
  children: RawRecord[];
  text: string;
  /** Serialized source of this record, kept as Issue evidence. */
  raw: string;
}

export function childText(node: RawRecord, name: string): string | null {
  const c = node.children.find((n) => n.name === name);
  const t = c?.text.trim();
  return t ? t : null;
}

export function children(node: RawRecord, name: string): RawRecord[] {
  return node.children.filter((n) => n.name === name);
}

/** Ensure every Product has at least the implicit default Variant (CONTEXT.md: Variant). */
export function withDefaultVariant(p: NormalizedProduct): NormalizedProduct {
  if (p.variants.length > 0) return p;
  return {
    ...p,
    variants: [
      {
        sku: p.productCode,
        gtin: p.gtin,
        price: null,
        currency: null,
        stock: null,
        attributes: {},
        isDefault: true,
      },
    ],
  };
}
