import { getStore } from '@netlify/blobs';

const STORE_NAME = 'elix-ai-jobs-v1';
const JOB_ID_RX = /^[A-Za-z0-9_-]{12,120}$/;

function store() {
  return getStore(STORE_NAME);
}

export function assertJobId(jobId) {
  const id = String(jobId || '').trim();
  if (!JOB_ID_RX.test(id)) {
    const err = new Error('Identificador de tarea inválido.');
    err.statusCode = 400;
    throw err;
  }
  return id;
}

export async function setJob(jobId, value) {
  const id = assertJobId(jobId);
  await store().setJSON(id, {
    ...value,
    job_id: id,
    updated_at: new Date().toISOString(),
  });
}

export async function patchJob(jobId, patch) {
  const id = assertJobId(jobId);
  const current = await getJob(id) || {};
  await setJob(id, { ...current, ...patch });
}

export async function getJob(jobId) {
  const id = assertJobId(jobId);
  return await store().get(id, { type: 'json' });
}
