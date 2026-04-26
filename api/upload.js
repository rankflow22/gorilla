export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { provider, cloudName, uploadPreset, imgbbKey, imageBase64, fileName, mimeType } = req.body;

  try {
    if (provider === 'cloudinary') {
      if (!cloudName || !uploadPreset) return res.status(400).json({ error: 'Missing cloudName or uploadPreset' });
      const boundary = '----FormBoundary' + Math.random().toString(36);
      const dataUri = `data:${mimeType||'image/jpeg'};base64,${imageBase64}`;
      const body = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"',
        '',
        dataUri,
        `--${boundary}`,
        'Content-Disposition: form-data; name="upload_preset"',
        '',
        uploadPreset,
        `--${boundary}--`,
      ].join('\r\n');
      const r = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body,
      });
      const d = await r.json();
      if (d.secure_url) return res.status(200).json({ url: d.secure_url });
      throw new Error(d.error?.message || 'Cloudinary upload failed');
    }

    if (provider === 'imgbb') {
      if (!imgbbKey) return res.status(400).json({ error: 'Missing imgbbKey' });
      const params = new URLSearchParams();
      params.append('image', imageBase64);
      const r = await fetch(`https://api.imgbb.com/1/upload?key=${imgbbKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      const d = await r.json();
      if (d.success) return res.status(200).json({ url: d.data.url });
      throw new Error(d.error?.message || 'ImgBB upload failed');
    }

    res.status(400).json({ error: 'Unknown provider: ' + provider });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
