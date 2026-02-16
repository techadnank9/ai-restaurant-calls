import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function loadRootEnv() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const rootEnvPath = path.resolve(__dirname, '../../.env');

  if (!fs.existsSync(rootEnvPath)) return {};

  const content = fs.readFileSync(rootEnvPath, 'utf8');
  const entries = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const idx = line.indexOf('=');
      if (idx === -1) return null;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
      return [key, value];
    })
    .filter(Boolean);

  return Object.fromEntries(entries);
}

const rootEnv = loadRootEnv();

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    typedRoutes: true
  },
  env: {
    NEXT_PUBLIC_SUPABASE_URL:
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? rootEnv.NEXT_PUBLIC_SUPABASE_URL ?? '',
    NEXT_PUBLIC_SUPABASE_ANON_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? rootEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? rootEnv.NEXT_PUBLIC_API_URL ?? ''
  }
};

export default nextConfig;
