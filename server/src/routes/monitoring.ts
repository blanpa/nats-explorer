import { Router } from 'express';
import { connectionStore } from '../nats/connection-manager.js';

export const monitoringRouter: Router = Router();

// Proxy NATS monitoring HTTP API
// The monitoring URL is derived from the connection config or provided explicitly
monitoringRouter.get('/monitoring/:connId/:endpoint', async (req, res) => {
  try {
    const { connId, endpoint } = req.params;
    const managed = connectionStore.get(connId);
    if (!managed) return res.status(404).json({ error: 'Connection not found' });

    // Build monitoring URL
    // Try to derive from server config - monitoring is typically on port 8222
    // User can set monitoringUrl in connection config
    const config = managed.config as any;
    let monitoringUrl = config.monitoringUrl;

    if (!monitoringUrl) {
      // Derive from server URL: nats://host:4222 -> http://host:8222
      const serverUrl = config.servers[0] || '';
      const match = serverUrl.match(/nats:\/\/([^:]+):?(\d+)?/);
      if (match) {
        const host = match[1];
        const natsPort = parseInt(match[2] || '4222');
        // Common convention: monitoring port = nats port + 4000 (4222 -> 8222)
        const monPort = config.monitoringPort || (natsPort + 4000);
        monitoringUrl = `http://${host}:${monPort}`;
      }
    }

    if (!monitoringUrl) {
      return res.status(400).json({ error: 'Cannot determine monitoring URL. Set monitoringPort in connection settings.' });
    }

    const allowedEndpoints = ['varz', 'connz', 'routez', 'subsz', 'jsz', 'healthz', 'accountz', 'gatewayz', 'leafz'];
    if (!allowedEndpoints.includes(endpoint)) {
      return res.status(400).json({ error: `Invalid endpoint: ${endpoint}` });
    }

    // Forward query params
    const queryString = Object.entries(req.query)
      .filter(([k]) => k !== 'connId')
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    const url = `${monitoringUrl}/${endpoint}${queryString ? '?' + queryString : ''}`;

    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      return res.status(response.status).json({ error: `Monitoring API returned ${response.status}` });
    }
    const data = await response.json();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
