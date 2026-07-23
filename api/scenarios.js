// Vercel serverless function: shared scenario library backed by Vercel Blob.
// Works with PRIVATE Blob stores - reads are proxied through this function so
// the browser never needs a public blob URL.
//
//   GET  /api/scenarios            -> list saved sets [{name, id, uploadedAt}]
//   GET  /api/scenarios?id=<path>  -> return one saved set {name, savedAt, state}
//   POST /api/scenarios            -> save posted {name, state} as a NEW entry
//                                     (409 if the name is already in use)
//   DELETE /api/scenarios?id=<path> -> soft-delete a saved set (archives a copy
//                                     to archive/ first, then removes it)
//
// Requires a Blob store connected to this project and BLOB_READ_WRITE_TOKEN
// present in the project's Environment Variables (all environments).

const { put, list, del } = require("@vercel/blob");

const TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const PREFIX = "scenarios/";
const ARCHIVE = "archive/";     // soft-deleted copies live here (owner-only, never listed)

function nameFromPath(pathname) {
  const base = pathname.replace(/^scenarios\//, "").replace(/\.json$/, "");
  const sep = base.indexOf("__");
  if (sep < 0) return base;
  try { return decodeURIComponent(base.slice(sep + 2)); }
  catch { return base.slice(sep + 2); }
}

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return null; } }
  return await new Promise(resolve => {
    let data = "";
    req.on("data", c => (data += c));
    req.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    req.on("error", () => resolve(null));
  });
}

// Download a blob's JSON content server-side. Tries the download URL and the
// canonical URL, each with and without the auth token, so it works whether the
// store is private (needs auth) or public (doesn't).
async function downloadJson(b) {
  const attempts = [
    [b.downloadUrl, true], [b.downloadUrl, false],
    [b.url, true],         [b.url, false],
  ].filter(a => a[0]);
  let lastErr;
  for (const [url, auth] of attempts) {
    try {
      const r = await fetch(url, auth ? { headers: { authorization: `Bearer ${TOKEN}` } } : undefined);
      if (r.ok) return await r.json();
      lastErr = new Error("download status " + r.status);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("download failed");
}

// Save preferring private access (matches private stores); fall back to public.
async function saveBlob(pathname, payload) {
  const base = { contentType: "application/json", addRandomSuffix: false, token: TOKEN };
  try {
    return await put(pathname, payload, { ...base, access: "private" });
  } catch (ePriv) {
    try {
      return await put(pathname, payload, { ...base, access: "public" });
    } catch (ePub) {
      throw new Error(
        "save failed - private attempt: " + (ePriv && ePriv.message || ePriv) +
        " || public attempt: " + (ePub && ePub.message || ePub)
      );
    }
  }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  try {
    if (req.method === "GET") {
      let id = null;
      try { id = new URL(req.url, "http://localhost").searchParams.get("id"); } catch {}

      const { blobs } = await list({ prefix: PREFIX, token: TOKEN });

      if (id) {
        const b = blobs.find(x => x.pathname === id);
        if (!b) { res.status(404).json({ error: "not found" }); return; }
        const doc = await downloadJson(b);
        res.status(200).json(doc);
        return;
      }

      const items = blobs.map(b => ({
        name: nameFromPath(b.pathname),
        id: b.pathname,
        uploadedAt: b.uploadedAt,
      })).sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
      res.status(200).json(items);
      return;
    }

    if (req.method === "POST") {
      const body = await readJson(req);
      const name = (body && body.name ? String(body.name) : "Untitled").slice(0, 120);
      const state = body && body.state;
      if (!state) { res.status(400).json({ error: "missing 'state'" }); return; }

      // Reject a name that's already in use (case-insensitive).
      const existing = await list({ prefix: PREFIX, token: TOKEN });
      const taken = existing.blobs.some(
        b => nameFromPath(b.pathname).toLowerCase() === name.toLowerCase()
      );
      if (taken) { res.status(409).json({ error: "name in use" }); return; }

      const ts = Date.now();
      const pathname = `${PREFIX}${ts}__${encodeURIComponent(name)}.json`;
      const payload = JSON.stringify({ name, savedAt: new Date(ts).toISOString(), state });
      await saveBlob(pathname, payload);
      res.status(200).json({ ok: true, name, id: pathname, uploadedAt: new Date(ts).toISOString() });
      return;
    }

    if (req.method === "DELETE") {
      let id = null;
      try { id = new URL(req.url, "http://localhost").searchParams.get("id"); } catch {}
      if (!id) { res.status(400).json({ error: "missing id" }); return; }
      const { blobs } = await list({ prefix: PREFIX, token: TOKEN });
      const b = blobs.find(x => x.pathname === id);
      if (!b) { res.status(404).json({ error: "not found" }); return; }

      // Soft delete: archive a copy FIRST, then remove from the visible library.
      // If archiving fails we abort (throws) so no data is lost. The archive/
      // area is never listed by this API - only reachable via your Vercel account.
      const doc = await downloadJson(b);
      const delTs = Date.now();
      const arcName = `${ARCHIVE}${delTs}__${encodeURIComponent(nameFromPath(b.pathname))}.json`;
      const arcPayload = JSON.stringify({
        ...doc,
        deletedAt: new Date(delTs).toISOString(),
        originalPathname: b.pathname,
      });
      await saveBlob(arcName, arcPayload);   // throws if it can't archive -> delete aborted

      await del(b.url, { token: TOKEN });
      res.status(200).json({ ok: true, archived: arcName });
      return;
    }

    res.status(405).json({ error: "method not allowed" });
  } catch (err) {
    console.error("api/scenarios error:", (err && err.message) || err);
    res.status(500).json({ error: String((err && err.message) || err) });
  }
};
