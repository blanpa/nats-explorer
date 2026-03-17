import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import dotenv from 'dotenv';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { connectionRouter } from './routes/connection.js';
import { publishRouter } from './routes/publish.js';
import { requestRouter } from './routes/request.js';
import { streamsRouter } from './routes/streams.js';
import { consumersRouter } from './routes/consumers.js';
import { kvRouter } from './routes/kv.js';
import { objectStoreRouter } from './routes/objectstore.js';
import { monitoringRouter } from './routes/monitoring.js';
import { servicesRouter } from './routes/services.js';
import { handleWebSocket } from './ws/handler.js';

dotenv.config();

const app = express();
const port = parseInt(process.env.PORT || '3002', 10);

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.use('/api', connectionRouter);
app.use('/api', publishRouter);
app.use('/api', requestRouter);
app.use('/api', streamsRouter);
app.use('/api', consumersRouter);
app.use('/api', kvRouter);
app.use('/api', objectStoreRouter);
app.use('/api', monitoringRouter);
app.use('/api', servicesRouter);

// Serve static client files in production
const publicPath = process.env.__PUBLIC_PATH
  || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'dist');

if (existsSync(publicPath)) {
  app.use(express.static(publicPath));
  // SPA fallback: serve index.html for non-API routes
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(join(publicPath, 'index.html'));
    }
  });
  console.log(`Serving static files from ${publicPath}`);
}

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  handleWebSocket(ws);
});

server.listen(port, () => {
  console.log(`NATS Explorer running on http://localhost:${port}`);
});
