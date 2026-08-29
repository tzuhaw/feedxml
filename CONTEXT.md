# Feed Ingestion

Ingests complete product-catalog snapshots from suppliers (via upload, pull, SFTP, or scrape) into the catalog database, with staged validation and human review of anomalies.

## Language

### Sources

**Supplier**:
An external party whose catalog we ingest. Owns Products; authenticates with its own API key.
_Avoid_: vendor, partner, source

**Feed**:
The standing arrangement that produces Snapshots for one Supplier over one Channel: format, schedule, thresholds, and skip-streak limit all attach here. A Supplier may have more than one Feed.
_Avoid_: using "feed" for a single file (that is a Snapshot) or a single ingestion (that is a Run)

**Channel**:
The delivery mechanism of a Feed: push (pre-signed upload), pull, SFTP, or scrape.
_Avoid_: integration, source type

### Feed lifecycle

**Snapshot**:
One complete statement of a supplier's catalog at a point in time, delivered as a single file. Always the whole catalog, never a partial update.
_Avoid_: delta, batch, dump

**Run**:
One attempt to ingest one Snapshot, tracked from arrival through merge (or halt/failure/supersession).
_Avoid_: job, import, sync

**Superseded**:
The terminal state of a Run abandoned because a newer Snapshot from the same Supplier arrived before its merge began. Visible in the panel, never hidden.
_Avoid_: cancelled, skipped run

**Halted**:
A Run stopped before applying anything because an aggregate threshold was breached. Waits for a human verdict: Approve or Reject — unless a newer Snapshot arrives first, in which case it is Superseded and its issue closes itself.
_Avoid_: paused, blocked, on hold

**Approve**:
The human verdict that a Halted Run's Snapshot is true. Applies the full merge including the Deactivation Sweep — never a partial apply.

**Reject**:
The human verdict that a Halted Run's Snapshot is wrong. Discards the Run; nothing is applied; staging is kept until resolution.

**Consequence Preview**:
The counts (creates, updates, deactivations) computed from staging and shown before an Approve can be clicked.

### Issues

**Issue**:
A recorded anomaly awaiting attention, at one of three scopes: Record (one record in one Snapshot failed validation), Product (a bad state across Runs, e.g. a Skip streak), or Run (a Snapshot needing a human verdict). One entity, one inbox.
_Avoid_: error, alert, review item, data issue

**Auto-resolution**:
An Issue closing itself when reality moves on: Record and Product Issues resolve when the product ingests cleanly in a later Run; Run Issues resolve only by verdict (Approve, Reject, or Superseded). Whatever remains open is still true.

### Catalog

**Product**:
The grouping a Supplier presents as one catalog entry. Identified by Supplier + Product Code. Not directly sellable.
_Avoid_: item, article, parent

**Variant**:
The sellable unit, with its own SKU, price, stock, and GTIN. Always belongs to exactly one Product. A Product whose feed record declares no variants gets one implicit default Variant.
_Avoid_: option, child product, size/color

**Product Code**:
The supplier-assigned identifier of a Product. Unique per Supplier, not globally.
_Avoid_: supplier SKU, product SKU, model number

**SKU**:
The identifier of a Variant — and of nothing else, ever. GTIN/EAN attaches at this level; a product-level GTIN is only a fallback when a feed supplies one there.
_Avoid_: using "SKU" for a Product

### Record fates

**Missing**:
A product that appears in no record of the current Snapshot — not even a malformed one. The only condition the Deactivation Sweep acts on.
_Avoid_: absent, deleted, not found

**Skipped**:
A product whose record is present in the Snapshot but failed validation. It retains its last known good state and stays active; the failure is recorded as an Issue.
_Avoid_: missing, rejected, dropped

**Last known good state**:
The most recent successfully-ingested version of a product, retained while its incoming records are Skipped.

**Skip streak**:
The count of consecutive Runs in which a product was Skipped. Reaching the streak limit (per-Supplier config, default 3) escalates a per-product Issue.

**Deactivation Sweep**:
The post-merge step that marks Missing products inactive. Never hard-deletes; only acts on Missing products, never on Skipped or Pinned ones; refuses to run when aggregate thresholds are breached.
_Avoid_: cleanup, purge, delete pass

**Pinned**:
A product exempted from the Deactivation Sweep by an admin reversing its deactivation. Exists only as that side effect, clears itself when the product reappears in a Snapshot, and shows as a standing count in the panel.
_Avoid_: locked, protected, whitelisted

**Reactivation**:
The automatic return of an inactive product to active when it reappears in a Snapshot. Ordinary merge behavior with an audit row — requires no human approval.
_Avoid_: resurrection, restore
