// Vercel serverless: o análogo do GetFileInfo do .NET (§5 do next_10-backend-ingest-handoff).
// Devolve o MESMO shape que a API do Coordly vai devolver em produção — status +
// as 6 URLs assinadas + expiração — só que assinando o R2 no lugar do Azure Blob.
// O client não sabe a diferença: é esse contrato que ele consome, não o storage.
//
//   GET /api/file-info?model=dor/v4  → { status, artifacts:{...}, expiresAt }
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

// nome no contrato → arquivo do ingest. Os 3 primeiros são o tier 1 (desenhar);
// dataModel e symbolic são tier 2, baixados só se o usuário pedir.
const ARTIFACTS = {
  mesh: 'mesh.parquet',
  vertex: 'vertex.parquet',
  index: 'index.parquet',
  metadata: 'metadata.json',
  dataModel: 'datamodel.parquet',
  symbolic: 'symbolic.json',
};

const EXPIRES_IN = 3600; // 1h, como o SAS por open

export default async function handler(req, res) {
  const CODE = process.env.ACCESS_CODE;
  if (CODE && String(req.query.code || '') !== CODE) {
    return res.status(403).json({ error: 'forbidden' });
  }

  // mesmo travamento do /api/sign: sem traversal e só nos prefixos conhecidos
  const model = String(req.query.model || '').replace(/\/+$/, '');
  if (!model || model.includes('..') || !/^(federated|dor)\//.test(model)) {
    return res.status(400).json({ error: 'invalid model' });
  }

  try {
    const entries = await Promise.all(
      Object.entries(ARTIFACTS).map(async ([name, file]) => [
        name,
        await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: `${model}/${file}` }),
          { expiresIn: EXPIRES_IN },
        ),
      ]),
    );
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      status: 'ready',
      artifacts: Object.fromEntries(entries),
      expiresAt: new Date(Date.now() + EXPIRES_IN * 1000).toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
