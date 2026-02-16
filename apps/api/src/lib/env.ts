import dotenv from 'dotenv';

dotenv.config({ path: '../../.env' });
dotenv.config();

export const env = {
  PORT: Number(process.env.API_PORT ?? 8080),
  SUPABASE_URL: process.env.SUPABASE_URL ?? '',
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
  MEDIA_WS_URL: process.env.MEDIA_WS_URL ?? 'ws://localhost:8081/media-stream',
  APP_BASE_URL: process.env.APP_BASE_URL ?? 'http://localhost:8080',
  LLM_API_KEY: process.env.NVIDIA_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
  LLM_BASE_URL: process.env.NVIDIA_BASE_URL ?? process.env.OPENAI_BASE_URL ?? '',
  LLM_MODEL:
    process.env.NVIDIA_LLM_MODEL ?? process.env.OPENAI_MODEL ?? 'nvidia/llama-3.3-nemotron-super-49b-v1.5',
  TWILIO_SPEECH_GATHER_ENABLED:
    (process.env.TWILIO_SPEECH_GATHER_ENABLED ?? 'false').toLowerCase() === 'true',
  INTERNAL_API_KEY: process.env.INTERNAL_API_KEY ?? ''
};
