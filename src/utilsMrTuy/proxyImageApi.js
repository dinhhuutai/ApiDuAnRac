const express = require("express");

const router = express.Router();

const DEFAULT_HOSTS = [
  "api.thuanhunglongan.com",
  "api.noibo.thuanhunglongan.com",
  "noibo.thuanhunglongan.com",
];

function allowedHostSet() {
  const fromEnv = (process.env.PROXY_IMAGE_ALLOWED_HOSTS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set([
    ...DEFAULT_HOSTS.map((h) => h.toLowerCase()),
    ...fromEnv,
  ]);
}

function isImageContentType(ct, pathname) {
  const c = (ct || "").toLowerCase();
  if (c.includes("webp")) return false;
  if (c.startsWith("image/")) return true;
  if (/\.(png|jpe?g|gif)(\?|$)/i.test(pathname || "")) return true;
  return false;
}

/**
 * GET /api/public/proxy-image?url=<encoded image URL>
 * Server-side fetch avoids browser CORS when embedding QR in Excel.
 */
router.get("/proxy-image", async (req, res) => {
  const raw = req.query.url;
  if (!raw || typeof raw !== "string") {
    return res.status(400).json({ error: "missing_url" });
  }

  let target;
  try {
    target = new URL(raw);
  } catch {
    return res.status(400).json({ error: "invalid_url" });
  }

  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return res.status(400).json({ error: "invalid_protocol" });
  }

  const host = target.hostname.toLowerCase();
  if (!allowedHostSet().has(host)) {
    return res.status(403).json({ error: "host_not_allowed" });
  }

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 25000);
    const upstream = await fetch(target.href, {
      signal: ac.signal,
      redirect: "follow",
      headers: { "User-Agent": "THLA-ExcelExport/1" },
    });
    clearTimeout(timer);

    if (!upstream.ok) {
      return res
        .status(502)
        .json({ error: "upstream", status: upstream.status });
    }

    const ct = upstream.headers.get("content-type") || "";
    const buf = Buffer.from(await upstream.arrayBuffer());

    if (buf.length === 0) {
      return res.status(502).json({ error: "empty" });
    }
    if (buf.length > 20 * 1024 * 1024) {
      return res.status(413).json({ error: "too_large" });
    }
    if (!isImageContentType(ct, target.pathname)) {
      return res.status(415).json({ error: "not_image" });
    }

    const safeCt = (ct.split(";")[0] || "").trim().toLowerCase();
    res.setHeader(
      "Content-Type",
      safeCt.startsWith("image/") ? safeCt : "image/png",
    );
    res.setHeader("Cache-Control", "private, max-age=120");
    return res.status(200).send(buf);
  } catch (e) {
    if (e.name === "AbortError") {
      return res.status(504).json({ error: "timeout" });
    }
    console.error("proxy-image", e.message);
    return res.status(500).json({ error: "proxy_failed" });
  }
});

module.exports = router;
