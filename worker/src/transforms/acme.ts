import {
  childText,
  children,
  type FeedTransform,
  type RawRecord,
  type TransformResult,
  type Variant,
  type ProductImage,
} from "@feedxml/shared";

/**
 * Fixture-supplier transform ("acme"). The shape every real supplier transform
 * follows: isolate one record node, return a normalized product or a skip verdict.
 * Replace with real-supplier transforms as feeds are onboarded (Sprint 5).
 */
export const acmeTransform: FeedTransform = {
  recordElement: "product",

  transform(node: RawRecord): TransformResult {
    const productCode = node.attributes["code"] ?? childText(node, "code");
    if (!productCode) {
      return {
        ok: false,
        skipped: { productCode: null, reason: "missing product code", rawFragment: node.raw },
      };
    }
    const title = childText(node, "title");
    if (!title) {
      return {
        ok: false,
        skipped: { productCode, reason: "missing title", rawFragment: node.raw },
      };
    }

    const variants: Variant[] = [];
    const variantsNode = node.children.find((c) => c.name === "variants");
    for (const v of variantsNode ? children(variantsNode, "variant") : []) {
      const sku = v.attributes["sku"] ?? childText(v, "sku");
      if (!sku) {
        return {
          ok: false,
          skipped: { productCode, reason: "variant without SKU", rawFragment: node.raw },
        };
      }
      const price = childText(v, "price");
      if (price && Number.isNaN(Number(price))) {
        return {
          ok: false,
          skipped: { productCode, reason: `unparseable price "${price}"`, rawFragment: node.raw },
        };
      }
      variants.push({
        sku,
        gtin: v.attributes["gtin"] ?? childText(v, "gtin"),
        price,
        currency: childText(v, "currency"),
        stock: toInt(childText(v, "stock")),
        attributes: collectAttributes(v),
      });
    }

    const images: ProductImage[] = [];
    const imagesNode = node.children.find((c) => c.name === "images");
    for (const img of imagesNode ? children(imagesNode, "image") : []) {
      const url = img.attributes["url"] ?? img.text.trim();
      if (url) images.push({ source_url: url, cdn_url: null, fetched_at: null });
    }

    return {
      ok: true,
      product: {
        productCode,
        title,
        description: childText(node, "description"),
        brand: childText(node, "brand"),
        gtin: childText(node, "gtin"),
        variants,
        images,
        attributes: collectAttributes(node),
      },
    };
  },
};

function toInt(s: string | null): number | null {
  if (s === null) return null;
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
}

function collectAttributes(node: RawRecord): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrsNode = node.children.find((c) => c.name === "attributes");
  for (const a of attrsNode ? children(attrsNode, "attribute") : []) {
    const name = a.attributes["name"];
    if (name) attrs[name] = a.text.trim();
  }
  return attrs;
}
