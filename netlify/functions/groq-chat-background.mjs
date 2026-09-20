import {
  parseBody,
  requireEnv,
  readJsonResponse,
  upstreamMessage,
  fetchWithTimeout,
} from './_shared/utils.mjs';
import { connectJobStore, assertJobId, setJob } from './_shared/jobs.mjs';

const ALLOWED_MODELS = [
  'qwen/qwen3.8-27b',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
];
const TOTAL_BUDGET_MS = 13 * 60 * 1000;
const PER_MODEL_MAX_MS = 4 * 60 * 1000;

export const handler = async (event) => {
  connectJobStore(event);
  let jobId = '';
  try {
    const body = parseBody(event);
    jobId = assertJobId(body.job_id);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length) throw new Error('No hay mensajes para Elix Mini O1.');

    const requested = Array.isArray(body.models) ? body.models : [];
    const models = requested.filter(m => ALLOWED_MODELS.includes(m));
    const queue = models.length ? models : ALLOWED_MODELS;
    const temperature = Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : 0;
    const maxTokens = Math.max(1, Math.min(Number(body.max_tokens) || 8192, 8192));
    const apiKey = requireEnv('GROQ_API_KEY');
    const deadline = Date.now() + TOTAL_BUDGET_MS;
    const failures = [];

    await setJob(jobId, {
      status: 'running',
      provider: 'groq',
      progress: 'Elix Mini O1 preparando el archivo.',
      started_at: new Date().toISOString(),
    });

    for (const model of queue) {
      const remaining = deadline - Date.now();
      if (remaining < 15000) break;

      await setJob(jobId, {
        status: 'running',
        provider: 'groq',
        model,
        progress: `Elix Mini O1 procesando con ${model}.`,
      });

      try {
        const timeout = Math.max(10000, Math.min(PER_MODEL_MAX_MS, remaining - 10000));
        const response = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
        }, timeout);

        const data = await readJsonResponse(response);
        if (!response.ok) {
          failures.push(`${model}: ${upstreamMessage(data, `${response.status} ${response.statusText}`)}`);
          continue;
        }

        const content = String(data?.choices?.[0]?.message?.content || '').trim();
        if (!content) {
          failures.push(`${model}: respuesta vacía`);
          continue;
        }

        await setJob(jobId, {
          status: 'done',
          provider: 'groq',
          model,
          result: { ...data, model },
          finished_at: new Date().toISOString(),
        });
        return;
      } catch (error) {
        failures.push(`${model}: ${error?.message || error}`);
      }
    }

    throw new Error(`Groq: fallaron los modelos configurados. ${failures.join(' | ')}`);
  } catch (error) {
    console.error('groq-chat-background', error);
    if (jobId) {
      try {
        await setJob(jobId, {
          status: 'error',
          provider: 'groq',
          error: error?.message || 'Error interno en Elix Mini O1.',
          upstream_status: Number(error?.statusCode) || 500,
          finished_at: new Date().toISOString(),
        });
      } catch (storeError) {
        console.error('No se pudo guardar el error del job Groq:', storeError);
      }
    }
  }
};
