import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { config } from './config.js';
import authRoutes from './routes/auth.js';
import { notFound, errorHandler } from './middleware/error.js';

const app = express();

app.set('trust proxy', config.trustProxy);
app.use(helmet());
app.use(cors({ origin: config.corsOrigins }));
app.use(express.json({ limit: '10kb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;
