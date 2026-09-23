import {
  parseBody,
  requireEnv,
  readJsonResponse,
  upstreamMessage,
  fetchWithTimeout,
  isRetryableStatus,
  sleep,
} from './_shared/utils.mjs';
import { connectJobStore, assertJobId, setJob } from './_shared/jobs.mjs';

const MODEL = 'gemini-3.1-flash-lite';
const TOTAL_BUDGET_MS = 13 * 60 * 1000;
const PER_ATTEMPT_MAX_MS = 6 * 60 * 1000;

export const handler = async (event) => {
  connectJobStore(event);
  let jobId = '';
  try {
    const body = parseBody(event);
    jobId = assertJobId(body.job_id);
    const payload = body.payload;
    if (!payload || typeof payload !== 'object') throw new Error('Falta el contenido para Elix AI.');

    const apiKey = requireEnv('GEMINI_API_KEY');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const deadline = Date.now() + TOTAL_BUDGET_MS;

    await setJob(jobId, {
      status: 'running',
      provider: 'elix',
      engine: 'elix-multimodal',
      progress: 'Elix AI procesando contenido.',
      started_at: new Date().toISOString(),
    });

    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining < 15000) break;
      await setJob(jobId, {
        status: 'running', provider: 'elix', engine: 'elix-multimodal', attempt,
        progress: attempt === 1 ? 'Elix AI analizando contenido.' : 'Elix AI reintentando el análisis.',
      });
      try {
        const timeout = Math.max(10000, Math.min(PER_ATTEMPT_MAX_MS, remaining - 10000));
        const response = await fetchWithTimeout(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }, timeout);
        const data = await readJsonResponse(response);
        if (response.ok) {
          await setJob(jobId, {
            status: 'done', provider: 'elix', engine: 'elix-multimodal',
            result: { ...data, _elix_model: 'Elix AI' }, finished_at: new Date().toISOString(),
          });
          return;
        }
        const err = new Error(`Elix AI: ${upstreamMessage(data, `${response.status} ${response.statusText}`)}`);
        err.statusCode = response.status;
        lastError = err;
        if (!isRetryableStatus(response.status) || attempt === 2) throw err;
      } catch (error) {
        lastError = error;
        if (attempt === 2 || !isRetryableStatus(error?.statusCode || 502)) throw error;
      }
      const pause = Math.min(3000, Math.max(500, deadline - Date.now() - 15000));
      if (pause > 0) await sleep(pause);
    }
    throw lastError || new Error('Elix AI no pudo completar el análisis dentro del tiempo disponible.');
  } catch (error) {
    console.error('elix-multimodal-background', error);
    if (jobId) {
      try {
        await setJob(jobId, {
          status: 'error', provider: 'elix', engine: 'elix-multimodal',
          error: error?.message || 'Error interno en Elix AI.',
          upstream_status: Number(error?.statusCode) || 500,
          finished_at: new Date().toISOString(),
        });
      } catch (storeError) {
        console.error('No se pudo guardar el error del job Elix:', storeError);
      }
    }
  }
};
