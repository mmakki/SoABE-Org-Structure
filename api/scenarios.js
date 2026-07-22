// Vercel serverless function: shared scenario library backed by Vercel Blob.
// GET  /api/scenarios        -> list saved scenario sets [{name, url, uploadedAt}]
// POST /api/scenarios        -> save the posted {name, state} as a NEW entry
//
// Storage: Vercel Blob. Connect a Blob store to this project in the Vercel
// dashboard (Storage tab) - that injects BLOB_READ_WRITE_TOKEN automatically,
// which @vercel/blob picks up. No token goes in this file.

const { put, list } = require("@vercel/blob");

async function readJson(req){
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return null; } }
  return await new Promise(resolve => {
    let data = "";
    req.on("data", c => (data += c));
    req.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    req.on("error", () => resolve(null));
  });
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  try {
    if (req.method === "GET") {
      const { blobs } = await list({ prefix: "scenarios/" });
      const items = blobs.map(b => {
        const base = b.pathname.replace(/^scenarios\//, "").replace(/\.json$/, "");
        const sep = base.indexOf("__");
        let name = base;
        if (sep >= 0) { try { name = decodeURIComponent(base.slice(sep + 2)); } catch { name = base.slice(sep + 2); } }
        return { name, url: b.url, pathname: b.pathname, uploadedAt: b.uploadedAt };
      }).sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
      res.status(200).json(items);
      return;
    }

    if (req.method === "POST") {
      const body = await readJson(req);
      const name = (body && body.name ? String(body.name) : "Untitled").slice(0, 120);
      const state = body && body.state;
      if (!state) { res.status(400).json({ error: "missing 'state'" }); return; }
      const ts = Date.now();
      const pathname = `scenarios/${ts}__${encodeURIComponent(name)}.json`;
      const payload = JSON.stringify({ name, savedAt: new Date(ts).toISOString(), state });
      const blob = await put(pathname, payload, {
        access: "public", contentType: "application/json", addRandomSuffix: false
      });
      res.status(200).json({ ok: true, name, url: blob.url, uploadedAt: new Date(ts).toISOString() });
      return;
    }

    res.status(405).json({ error: "method not allowed" });
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) });
  }
};
