# Graph Report - .  (2026-08-31)

## Corpus Check
- Corpus is ~49,197 words - fits in a single context window. You may not need a graph.

## Summary
- 629 nodes · 1093 edges · 47 communities (38 shown, 9 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 47 edges (avg confidence: 0.89)
- Token cost: 145,399 input · 0 output

## Community Hubs (Navigation)
- Worker Runtime and Entrypoints
- Admin Panel Pages
- Domain Vocabulary
- Streaming Parse Pipeline
- Snapshot Apply and Merge
- API Routes and Object Storage
- Web App Dependencies
- Worker Dependencies
- Shared Domain Types
- Sign-in and Session
- Web TypeScript Config
- Domain Package Manifest
- Object Storage and Upload
- Workspace Scripts
- CI and Test Method
- Adversarial Test Harness
- Load Testing and Scale
- Trigger and Safety-Net Cron
- Shared Package Manifest
- Documentation Set
- Base TypeScript Config
- Ingestion Channels and Layout
- Upload Form Component
- Authorization Bugs and Guard
- Domain TypeScript Config
- Worker TypeScript Config
- Product Identity Model
- Fencing and Retry Safety
- Streaming Core Design
- Shared TypeScript Config
- Upload Check Suite
- Test Honesty Lessons
- Root Layout
- Migration Runner
- Edge Middleware
- Next.js Config
- Next Type Shims
- Vercel Cron Config
- Database Connection Check
- Production Connectivity
- Threshold Validation Tests
- Access Control Checks

## God Nodes (most connected - your core abstractions)
1. `getPool()` - 37 edges
2. `requireAdmin()` - 20 edges
3. `executeRun()` - 18 edges
4. `compilerOptions` - 16 edges
5. `ago()` - 15 edges
6. `stageSnapshot()` - 13 edges
7. `registerAndLaunch()` - 12 edges
8. `readSession()` - 10 edges
9. `compilerOptions` - 10 edges
10. `feedxml README` - 10 edges

## Surprising Connections (you probably didn't know these)
- `CI Postgres 17 service container` --semantically_similar_to--> `Local Postgres on port 55432`  [INFERRED] [semantically similar]
  .github/workflows/ci.yml → docker-compose.yml
- `End-to-end pipeline load run step` --references--> `Shared streaming core`  [INFERRED]
  .github/workflows/loadtest.yml → DESIGN.md
- `MinIO stand-in for Cloudflare R2` --semantically_similar_to--> `Cloudflare R2 object storage (zero egress)`  [EXTRACTED] [semantically similar]
  docker-compose.yml → DESIGN.md
- `requireAdmin() page-level authorization guard` --semantically_similar_to--> `Admin panel returns 503 without credentials`  [INFERRED] [semantically similar]
  BUGS.md → README.md
- `Manual 100 MB snapshot upload page` --semantically_similar_to--> `Push channel (pre-signed multipart upload)`  [INFERRED] [semantically similar]
  RUNBOOK.md → DESIGN.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Four arrival channels converge on one immutable bucket object** — design_push_channel, design_pull_channel, design_sftp_channel, design_scrape_channel, design_bucket_layout, design_r2_object_storage [EXTRACTED 1.00]
- **Record fates that decide what the Deactivation Sweep may touch** — context_missing, context_skipped, context_last_known_good_state, context_pinned, context_deactivation_sweep, context_reactivation [EXTRACTED 1.00]
- **The halted-run verdict flow** — context_halted, context_consequence_preview, context_approve, context_reject, context_superseded, design_two_email_notifications [EXTRACTED 1.00]

## Communities (47 total, 9 thin omitted)

### Community 0 - "Worker Runtime and Entrypoints"
Cohesion: 0.06
Nodes (45): main(), main(), main(), notifyOps(), StageResult, registerTransform(), transformFor(), transforms (+37 more)

### Community 1 - "Admin Panel Pages"
Cohesion: 0.12
Nodes (45): actor(), approveRunAction(), assertAdmin(), reingestAction(), rejectRunAction(), requireId(), resolveIssueAction(), retryRunAction() (+37 more)

### Community 2 - "Domain Vocabulary"
Cohesion: 0.07
Nodes (42): Approve verdict, Auto-resolution of Issues, Consequence Preview, Deactivation Sweep, Halted, Issue (Record/Product/Run scope), Last known good state, Missing (+34 more)

### Community 3 - "Streaming Parse Pipeline"
Cohesion: 0.08
Nodes (22): parseNdjsonRecords(), singular(), TEXT_KEYS, toRawRecord(), escapeXml(), parse(), parseXmlRecords(), serialize() (+14 more)

### Community 4 - "Snapshot Apply and Merge"
Cohesion: 0.13
Nodes (20): approveRun(), audit(), diagnoseClaimFailure(), rejectRun(), reverseDeactivation(), ApplyResult, applyRun(), auditBatch() (+12 more)

### Community 5 - "API Routes and Object Storage"
Cohesion: 0.20
Nodes (21): POST(), GET(), POST(), POST(), authenticateSupplier(), secretsMatch(), SupplierIdentity, currentAdmin() (+13 more)

### Community 6 - "Web App Dependencies"
Cohesion: 0.07
Nodes (28): dependencies, @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, bcryptjs, @feedxml/domain, @feedxml/shared, next, pg (+20 more)

### Community 7 - "Worker Dependencies"
Cohesion: 0.08
Nodes (24): dependencies, @aws-sdk/client-s3, @aws-sdk/lib-storage, bcryptjs, @feedxml/domain, @feedxml/shared, pg, sax (+16 more)

### Community 8 - "Shared Domain Types"
Cohesion: 0.08
Nodes (16): Channel, DEFAULT_THRESHOLDS, FeedConfig, FeedThresholds, FeedTransform, IssueScope, IssueStatus, NormalizedProduct (+8 more)

### Community 9 - "Sign-in and Session"
Cohesion: 0.17
Nodes (14): POST(), FeedStream(), Particle, MESSAGES, Home(), adminConfigured(), hmacKey(), issueSession() (+6 more)

### Community 10 - "Web TypeScript Config"
Cohesion: 0.10
Nodes (19): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+11 more)

### Community 11 - "Domain Package Manifest"
Cohesion: 0.12
Nodes (17): default, dependencies, @feedxml/shared, pg, devDependencies, @types/pg, typescript, exports (+9 more)

### Community 12 - "Object Storage and Upload"
Cohesion: 0.17
Nodes (15): BUG-7 presigned R2 URLs used virtual-host addressing, forcePathStyle on both S3 clients, No mapping DSL until repetition earns it, Per-supplier transform function, Push channel (pre-signed multipart upload), Per-supplier bcrypt API key contract, Storage is optional and off by default, MinIO stand-in for Cloudflare R2 (+7 more)

### Community 13 - "Workspace Scripts"
Cohesion: 0.13
Nodes (14): devDependencies, pg, name, private, scripts, build, db:down, db:migrate (+6 more)

### Community 14 - "CI and Test Method"
Cohesion: 0.15
Nodes (13): CI build-and-test job, CI Postgres 17 service container, Library build order: shared before domain, Bugs found by testing, and their fixes, Three-clean-rounds-then-expand method, What the adversarial suite now covers, Local development and test stack, Local Postgres on port 55432 (+5 more)

### Community 15 - "Adversarial Test Harness"
Cohesion: 0.24
Nodes (12): actionIds(), check(), login(), pool, postAction(), record(), req(), results (+4 more)

### Community 16 - "Load Testing and Scale"
Cohesion: 0.17
Nodes (12): Synthetic Snapshot generation step, Loadtest workflow job, End-to-end pipeline load run step, Snapshot, Deferred by design (reserved slots), Structured image objects for later rehost, Nested jsonb variants and images, The load-test number is a floor, not a baseline (+4 more)

### Community 17 - "Trigger and Safety-Net Cron"
Cohesion: 0.21
Nodes (12): Sweep endpoint bearer-secret call, Best-effort schedule, idempotent sweep, Five-minute sweep workflow, Hybrid idempotent trigger, One-sentence architecture, Restart-everything failure policy (maxRetries 3), Five-minute safety-net cron (decision 7), staging_products scoped by run_id (+4 more)

### Community 18 - "Shared Package Manifest"
Cohesion: 0.18
Nodes (11): default, exports, main, name, private, scripts, build, typecheck (+3 more)

### Community 19 - "Documentation Set"
Cohesion: 0.33
Nodes (11): CONTEXT.md canonical glossary, Channel, Feed (standing arrangement), One active Feed per format per Supplier, Supplier, Feed Ingestion System Design, Decision log (29 decisions), feedxml README (+3 more)

### Community 20 - "Base TypeScript Config"
Cohesion: 0.18
Nodes (10): compilerOptions, declaration, esModuleInterop, forceConsistentCasingInFileNames, module, moduleResolution, skipLibCheck, sourceMap (+2 more)

### Community 21 - "Ingestion Channels and Layout"
Cohesion: 0.22
Nodes (9): Bucket layout feeds/{supplier}/{timestamp}.{ext}, Pull channel, Cloudflare R2 object storage (zero egress), Scrape channel (feed producer), Repository layout (apps/web, worker, packages/shared), Scrape job operations (second Cloud Run job), Sprint 5 — Production: scraper, first real supplier, Where it runs, and why (+1 more)

### Community 22 - "Upload Form Component"
Cohesion: 0.33
Nodes (4): Feed, human(), Phase, UploadForm()

### Community 23 - "Authorization Bugs and Guard"
Cohesion: 0.29
Nodes (7): BUG-1 panel data leaked in the RSC payload, BUG-2 deep links lost their destination, BUG-3 authenticated visit to / showed the login form, BUG-6 signing-key cache delayed session revocation, Verification-free cookie-absence middleware, requireAdmin() page-level authorization guard, Admin panel returns 503 without credentials

### Community 24 - "Domain TypeScript Config"
Cohesion: 0.29
Nodes (6): compilerOptions, outDir, rootDir, types, extends, include

### Community 25 - "Worker TypeScript Config"
Cohesion: 0.29
Nodes (6): compilerOptions, outDir, rootDir, types, extends, include

### Community 26 - "Product Identity Model"
Cohesion: 0.40
Nodes (6): Product, Product Code, SKU (Variant identifier), Variant, Duplicate Product Code: last occurrence wins, Identity (supplier_id, product_code)

### Community 27 - "Fencing and Retry Safety"
Cohesion: 0.40
Nodes (6): Attempt as monotonic fencing token, 60-second worker heartbeat, A merge in flight is never restarted, Retry (re-execute the same run), "run failed after N attempts" email playbook, When it goes wrong (failure modes)

### Community 28 - "Streaming Core Design"
Cohesion: 0.40
Nodes (6): Pluggable format front-ends (XML, NDJSON), Scale by running longer, not by fanning out, Shared streaming core, Automated suite (42 tests, 4 files), Backpressure: a slow database slows the parse, Stage 3: the worker streams, never holding the file

### Community 29 - "Shared TypeScript Config"
Cohesion: 0.33
Nodes (5): compilerOptions, outDir, rootDir, extends, include

### Community 30 - "Upload Check Suite"
Cohesion: 0.33
Nodes (3): init2, pool, signed

### Community 31 - "Test Honesty Lessons"
Cohesion: 0.40
Nodes (5): Assert the rule, not the fixture, BUG-4 body-less login POST returned 500, BUG-5 non-UUID run id returned 500, Vacuous tests (a test that cannot fail), Login moved from a server action to POST /api/session

### Community 33 - "Migration Runner"
Cohesion: 0.50
Nodes (3): dir, here, pool

## Knowledge Gaps
- **199 isolated node(s):** `Particle`, `MESSAGES`, `Variant`, `View`, `NavKey` (+194 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **9 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `stageSnapshot()` connect `Streaming Parse Pipeline` to `Shared Domain Types`, `Worker Runtime and Entrypoints`?**
  _High betweenness centrality (0.016) - this node is a cross-community bridge._
- **Why does `getPool()` connect `Admin Panel Pages` to `Sign-in and Session`, `API Routes and Object Storage`?**
  _High betweenness centrality (0.012) - this node is a cross-community bridge._
- **What connects `Particle`, `MESSAGES`, `Variant` to the rest of the system?**
  _211 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Worker Runtime and Entrypoints` be split into smaller, more focused modules?**
  _Cohesion score 0.06095481670929241 - nodes in this community are weakly interconnected._
- **Should `Admin Panel Pages` be split into smaller, more focused modules?**
  _Cohesion score 0.12372881355932204 - nodes in this community are weakly interconnected._
- **Should `Domain Vocabulary` be split into smaller, more focused modules?**
  _Cohesion score 0.07200929152148665 - nodes in this community are weakly interconnected._
- **Should `Streaming Parse Pipeline` be split into smaller, more focused modules?**
  _Cohesion score 0.08048780487804878 - nodes in this community are weakly interconnected._