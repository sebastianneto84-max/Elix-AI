import {
  parseBody,
  requireEnv,
  readJsonResponse,
  upstreamMessage,
  fetchWithTimeout,
} from './_shared/utils.mjs';
import { assertJobId, setJob } from './_shared/jobs.mjs';

const MODEL = 'gemini-3.1-flash-lite';
const TIMEOUT_MS = 4 * 60 * 1000;

export const handler = async (event) => {
  let jobId = '';
  try {
    const body = parseBody(event);
    jobId = assertJobId(body.job_id);
    const payload = body.payload;
    if (!payload || typeof payload !== 'object') throw new Error('Falta el payload para Gemini.');

    const apiKey = requireEnv('GEMINI_API_KEY');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;

    await setJob(jobId, {
      status: 'running',
      provider: 'gemini',
      model: MODEL,
      progress: 'Gemini 3.1 Flash Lite procesando.',
      started_at: new Date().toISOString(),
    });

    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, TIMEOUT_MS);

    const data = await readJsonResponse(response);
    if (!response.ok) {
      const err = new Error(`Gemini ${MODEL}: ${upstreamMessage(data, `${response.status} ${response.statusText}`)}`);
      err.statusCode = response.status;
      throw err;
    }

    await setJob(jobId, {
      status: 'done',
      provider: 'gemini',
      model: MODEL,
      result: { ...data, _elix_model: MODEL },
      finished_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('gemini-generate-background', error);
    if (jobId) {
      try {
        await setJob(jobId, {
          status: 'error',
          provider: 'gemini',
          error: error?.message || 'Error interno en Gemini.',
          upstream_status: Number(error?.statusCode) || 500,
          finished_at: new Date().toISOString(),
        });
      } catch (storeError) {
        console.error('No se pudo guardar el error del job Gemini:', storeError);
      }
    }
  }
};
