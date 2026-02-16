import cors from 'cors';
import express from 'express';
import { env } from './lib/env.js';
import twilioRoutes from './routes/twilio.js';
import orderRoutes from './routes/orders.js';
import callRoutes from './routes/calls.js';
import menuRoutes from './routes/menu.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/twilio', twilioRoutes);
app.use('/orders', orderRoutes);
app.use('/calls', callRoutes);
app.use('/menu', menuRoutes);

app.listen(env.PORT, () => {
  console.log(`api listening on :${env.PORT}`);
});
