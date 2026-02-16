import dotenv from 'dotenv';

dotenv.config({ path: '../../.env' });
dotenv.config();

export const env = {
  PORT: Number(process.env.API_PORT ?? 8080),
  SUPABASE_URL: process.env.SUPABASE_URL ?? '',
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  MEDIA_WS_URL: process.env.MEDIA_WS_URL ?? 'ws://localhost:8081/media-stream',
  APP_BASE_URL: process.env.APP_BASE_URL ?? 'http://localhost:8080',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
  OPENAI_MODEL: process.env.OPENAI_MODEL ?? 'gpt-4o-mini'
};
