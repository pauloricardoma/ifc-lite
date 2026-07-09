// Vercel serverless: assina uma URL GET temporária do R2 (bucket PRIVADO).
// Análogo do .NET emitindo SAS. Creds do R2 vêm de ENV da Vercel (NUNCA no código).
//   GET /api/sign?key=federated/JA2-.../geometry.parquet  → { url: "<signed>" }
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

export default async function handler(req, res) {
  // Code-gate: sem o código certo (env ACCESS_CODE), nega tudo. O código é
  // checado AQUI (servidor), nunca vai pro bundle do browser.
  const CODE = process.env.ACCESS_CODE;
  if (CODE && String(req.query.code || '') !== CODE) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const key = String(req.query.key || '');
  // trava path traversal e chaves fora do prefixo esperado
  if (!key || key.includes('..') || !/^(federated|dor)\//.test(key)) {
    return res.status(400).json({ error: 'invalid key' });
  }
  try {
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }),
      { expiresIn: 3600 }, // 1h
    );
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ url });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
