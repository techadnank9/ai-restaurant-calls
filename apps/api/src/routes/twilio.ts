import { Router } from 'express';
import twilio from 'twilio';
import { supabaseAdmin } from '../lib/supabase.js';
import { env } from '../lib/env.js';

const router = Router();

router.post('/voice', async (req, res) => {
  const called = String(req.body?.Called ?? req.body?.To ?? '');

  const { data: restaurant } = await supabaseAdmin
    .from('restaurants')
    .select('id, name')
    .eq('twilio_number', called)
    .limit(1)
    .maybeSingle();

  const response = new twilio.twiml.VoiceResponse();
  const start = response.start();
  const stream = start.stream({
    url: env.MEDIA_WS_URL
  });

  if (restaurant?.id) {
    stream.parameter({ name: 'restaurant_id', value: restaurant.id });
    stream.parameter({ name: 'restaurant_name', value: restaurant.name });
  }
  stream.parameter({ name: 'called_number', value: called });

  response.say({ voice: 'alice' }, 'Hi, thanks for calling. Please tell me your pickup order after the beep.');
  response.record({
    transcribe: true,
    maxLength: 120,
    playBeep: true,
    action: `${env.APP_BASE_URL}/twilio/recording-complete`,
    method: 'POST'
  });

  res.type('text/xml').send(response.toString());
});

router.post('/recording-complete', async (req, res) => {
  const callSid = String(req.body?.CallSid ?? '');
  const recordingUrl = String(req.body?.RecordingUrl ?? '');

  if (callSid) {
    await supabaseAdmin.from('calls').upsert(
      {
        twilio_call_sid: callSid,
        recording_url: recordingUrl,
        status: 'completed'
      },
      { onConflict: 'twilio_call_sid' }
    );
  }

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say('Thank you. Your order is being processed. Goodbye.');
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

export default router;
