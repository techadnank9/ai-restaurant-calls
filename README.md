# ai-restaurant-calls

TypeScript npm-workspaces monorepo for AI restaurant phone ordering.

## Structure
- `apps/api`: Express REST API + Twilio webhook + Supabase auth middleware
- `apps/media-ws`: WebSocket server for Twilio Media Streams (`/media-stream`) + Redis session state
- `apps/web`: Next.js dashboard (orders, order detail, calls, menu editor) with Supabase Auth
- `packages/shared`: zod schemas + shared types
- `packages/supabase`: Supabase browser/server/service clients
- `infra/supabase/migrations.sql`: schema + RLS policies

## Prereqs
- Node 20+
- npm 10+ (or npm 11 recommended)
- Redis (docker-compose provided)
- Supabase project

## Setup
1. Copy envs:
   - `cp .env.example .env`
2. Start Redis:
   - `docker compose up -d redis`
3. Set NVIDIA key in `.env` for voice order conversation:
   - `NVIDIA_API_KEY=...`
   - `NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1`
   - `NVIDIA_LLM_MODEL=nvidia/llama-3.3-nemotron-super-49b-v1.5`
   - `NVIDIA_ASR_MODEL=nvidia/parakeet-1.1b-rnnt-multilingual-asr`
   - `INTERNAL_API_KEY=<shared secret between api and media-ws>`
   - `TWILIO_SPEECH_GATHER_ENABLED=false` (disables Twilio Gather STT charges)
4. Install dependencies:
   - `npm install`
5. Apply SQL in Supabase SQL editor:
   - `infra/supabase/migrations.sql`
6. Run apps:
   - `npm run dev:api`
   - `npm run dev:ws`
   - `npm run dev:web`
   - or all together: `npm run dev:all`

## Twilio webhook
- Configure voice webhook URL to: `POST {APP_BASE_URL}/twilio/voice`
- Endpoint returns TwiML that starts media streaming to `{MEDIA_WS_URL}`.
- Call recording should remain OFF in Twilio Console to avoid recording charges.
- With `TWILIO_SPEECH_GATHER_ENABLED=false`, media-ws performs silence-based turn chunking, transcribes with Parakeet, and posts turns to `/twilio/realtime-turn`.
- At call stop, media-ws also posts a full transcript to `/twilio/media-transcript` for final persistence.

## Restaurant Voice Config (menu_json.meta)
Store brand + greeting + strict behavior in each restaurant's `menu_json.meta`:

```json
{
  "meta": {
    "brand_name": "New Delhi Restaurant",
    "greeting_text": "Thanks for calling New Delhi Restaurant. Please tell me your pickup order.",
    "strict_menu_validation": true,
    "order_type_default": "pickup"
  },
  "categories": []
}
```

The Twilio + LLM flow enforces strict menu matching against `menu_json.categories[].items`.

## Deploy media-ws on Render
1. Push this repo to GitHub.
2. In Render, create a new Blueprint and select this repo.
3. Render will read `/render.yaml` and provision:
   - `ai-restaurant-media-ws` (web service)
   - `ai-restaurant-redis` (Key Value)
4. After deploy, copy the media service URL:
   - `https://<your-render-service>.onrender.com`
5. Set:
   - `MEDIA_WS_URL=wss://<your-render-service>.onrender.com/media-stream`
6. Keep Twilio webhook on your API service:
   - `POST {APP_BASE_URL}/twilio/voice`

## Minimal test commands
- Typecheck all packages/apps:
  - `npm run typecheck`
- Build all:
  - `npm run build`
- Health checks:
  - `curl http://localhost:8080/health`
  - `curl http://localhost:8081/health`

## Notes
- API auth middleware validates bearer JWT with:
  - `supabase.auth.getUser(jwt)`
- API body validation uses `zod` from `@arc/shared`.
- AI structured order output validation schema:
  - `packages/shared/src/index.ts` (`aiOrderOutputSchema`)
