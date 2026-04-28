export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { provider, imageBase64, fileName, mimeType,
    cloudName, uploadPreset,
    imgbbKey,
    bunnyStorageZone, bunnyAccessKey, bunnyStorageRegion, bunnyCdnHostname, bunnyFolder
  } = req.body;

  try {

    if (provider === 'bunny') {
      if (!bunnyStorageZone || !bunnyAccessKey || !bunnyCdnHostname) {
        return res.status(400).json({ error: 'Missing bunnyStorageZone, bunnyAccessKey, or bunnyCdnHostname' });
      }
      const regionPrefix = (bunnyStorageRegion || '').toLowerCase().trim();
      const storageHost = regionPrefix && regionPrefix !== 'de'
        ? `${regionPrefix}.storage.bunnycdn.com`
        : 'storage.bunnycdn.com';
      const folder = (bunnyFolder || '').replace(/^\/|\/$/g, '');
      const safeFileName = `${Date.now()}-${(fileName || 'image.jpg').replace(/[^a-zA-Z0-9._-]/g, '-')}`;
      const remotePath = folder
        ? `/${bunnyStorageZone}/${folder}/${safeFileName}`
        : `/${bunnyStorageZone}/${safeFileName}`;
      const buffer = Buffer.from(imageBase64, 'base64');
      const uploadUrl = `https://${storageHost}${remotePath}`;
      const r = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'AccessKey': bunnyAccessKey,
          'Content-Type': mimeType || 'image/jpeg',
        },
        body: buffer,
      });
      if (!r.ok) {
        const errText = await r.text();
        throw new Error(`Bunny upload failed (${r.status}): ${errText.substring(0, 200)}`);
      }
      const cdnHost = bunnyCdnHostname.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const publicUrl = folder
        ? `https://${cdnHost}/${folder}/${safeFileName}`
        : `https://${cdnHost}/${safeFileName}`;
      return res.status(200).json({ url: publicUrl });
    }

    if (provider === 'cloudinary') {
      if (!cloudName || !uploadPreset) {
        return res.status(400).json({ error: 'Missing cloudName or uploadPreset' });
      }
      const boundary = '----FormBoundary' + Math.random().toString(36);
      const dataUri = `data:${mimeType || 'image/jpeg'};base64,${imageBase64}`;
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
    res.status(500).json({ error: err.message || 'Upload error' });
  }
}
