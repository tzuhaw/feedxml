"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "@/lib/upload";

interface Feed {
  id: string;
  supplier: string;
  channel: string;
}

type Phase =
  | { kind: "idle" }
  | { kind: "signing" }
  | { kind: "uploading"; pct: number }
  | { kind: "registering" }
  | { kind: "error"; message: string };

function human(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/**
 * Browser → R2 directly on a presigned URL. The bytes never touch the Next
 * function, which is what makes a 100 MB file survivable on serverless; the
 * server only signs the target and, once the object is really there, registers
 * the run.
 */
export default function UploadForm({ feeds }: { feeds: Feed[] }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [feedId, setFeedId] = useState(feeds[0]?.id ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const busy = phase.kind !== "idle" && phase.kind !== "error";

  function choose(picked: File | null): void {
    setPhase({ kind: "idle" });
    if (!picked) {
      setFile(null);
      return;
    }
    if (!/\.xml$/i.test(picked.name)) {
      setFile(null);
      setPhase({ kind: "error", message: "That is not an .xml file." });
      return;
    }
    if (picked.size === 0) {
      setFile(null);
      setPhase({ kind: "error", message: "That file is empty." });
      return;
    }
    // The server enforces this too — this check exists so a person finds out
    // before waiting on a doomed upload, not because the client is trusted.
    if (picked.size > MAX_UPLOAD_BYTES) {
      setFile(null);
      setPhase({
        kind: "error",
        message: `${human(picked.size)} is over the ${MAX_UPLOAD_LABEL} limit for this page. Large feeds go through the supplier push channel.`,
      });
      return;
    }
    setFile(picked);
  }

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!file || !feedId || busy) return;

    try {
      setPhase({ kind: "signing" });
      const initRes = await fetch("/api/admin/upload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "init", feedId, size: file.size }),
      });
      const init = await initRes.json().catch(() => ({}));
      if (!initRes.ok) throw new Error(init.error ?? `init failed (${initRes.status})`);

      setPhase({ kind: "uploading", pct: 0 });
      await put(init.url, file, (pct) => setPhase({ kind: "uploading", pct }));

      setPhase({ kind: "registering" });
      const doneRes = await fetch("/api/admin/upload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "complete", objectKey: init.objectKey }),
      });
      const done = await doneRes.json().catch(() => ({}));
      if (!doneRes.ok) throw new Error(done.error ?? `registration failed (${doneRes.status})`);

      router.push(`/admin/runs/${done.runId}`);
    } catch (err) {
      setPhase({
        kind: "error",
        message: err instanceof Error ? err.message : "Upload failed.",
      });
    }
  }

  return (
    <form onSubmit={submit} className="upload">
      <label className="field">
        <span>Feed</span>
        <select
          value={feedId}
          onChange={(e) => setFeedId(e.target.value)}
          disabled={busy}
          className="upload-select"
        >
          {feeds.map((f) => (
            <option key={f.id} value={f.id}>
              {f.supplier} — {f.channel}
            </option>
          ))}
        </select>
      </label>

      <div
        className={`drop${file ? " has-file" : ""}`}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (!busy) choose(e.dataTransfer.files?.[0] ?? null);
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".xml,application/xml,text/xml"
          disabled={busy}
          onChange={(e) => choose(e.target.files?.[0] ?? null)}
          className="drop-input"
          id="feed-file"
        />
        <label htmlFor="feed-file" className="drop-label">
          {file ? (
            <>
              <strong>{file.name}</strong>
              <span className="drop-note">{human(file.size)} · ready to upload</span>
            </>
          ) : (
            <>
              <strong>Choose an XML file, or drop it here</strong>
              <span className="drop-note">Up to {MAX_UPLOAD_LABEL}</span>
            </>
          )}
        </label>
      </div>

      {phase.kind === "uploading" && (
        <div className="progress" role="progressbar" aria-valuenow={phase.pct}>
          <div className="progress-bar" style={{ width: `${phase.pct}%` }} />
          <span className="progress-text">{phase.pct}%</span>
        </div>
      )}
      {phase.kind === "signing" && <p className="muted">Preparing the upload…</p>}
      {phase.kind === "registering" && <p className="muted">Registering the run…</p>}
      {phase.kind === "error" && <p className="error">{phase.message}</p>}

      <div className="act-row">
        <button type="submit" className="act act-primary" disabled={!file || !feedId || busy}>
          {busy ? "Working…" : "Upload and ingest"}
        </button>
        {file && !busy && (
          <button
            type="button"
            className="act"
            onClick={() => {
              setFile(null);
              setPhase({ kind: "idle" });
              if (inputRef.current) inputRef.current.value = "";
            }}
          >
            Clear
          </button>
        )}
      </div>
    </form>
  );
}

/** XHR rather than fetch: only XHR reports upload progress. */
function put(url: string, file: File, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(
            new Error(
              `Storage rejected the upload (${xhr.status}). If this is the first upload, check the bucket's CORS rules allow PUT from this origin.`,
            ),
          );
    xhr.onerror = () =>
      reject(
        new Error(
          "Could not reach object storage. This is usually a missing CORS rule on the bucket.",
        ),
      );
    xhr.send(file);
  });
}
