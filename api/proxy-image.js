// Vercel serverless function — Discogs CDN image proxy
//
// Replaces api.php's proxy_image action. Streams Discogs CDN images
// through our domain so Canvas can read pixel data without CORS taint
// (used by Share My Stats and Share a Pick image generators).
//
// Reachable at: https://elbrinks-crate.vercel.app/api/proxy-image?url=...
// And via the hub rewrite at: https://elbrink.com/vinyl/api/proxy-image?url=...

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  const url = req.query.url;

  if (!url || typeof url !== 'string' || !/^https:\/\/i\.discogs\.com\//.test(url)) {
    res.status(400).json({ error: 'Invalid image URL' });
    return;
  }

  try {
    const upstream = await fetch(url, {
      headers: { 'User-Agent': 'ElbrinksCrate/1.0' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });

    if (!upstream.ok) {
      res.status(502).json({ error: 'Failed to fetch image' });
      return;
    }

    const contentType = upstream.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await upstream.arrayBuffer());

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.status(200).send(buffer);
  } catch (e) {
    res.status(502).json({ error: 'Failed to fetch image' });
  }
}
