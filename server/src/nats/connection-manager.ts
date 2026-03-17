import { connect, NatsConnection, credsAuthenticator, nkeyAuthenticator, StringCodec } from 'nats';
import { EventEmitter } from 'events';
import type { ConnectionConfig, ConnectionStatus } from 'shared';
import { SubscriptionManager } from './subscription-manager.js';

export interface ManagedConnection {
  id: string;
  config: ConnectionConfig;
  nc: NatsConnection;
  subscriptionManager: SubscriptionManager;
  color: string;
}

const COLORS = ['#4EC9B0', '#569cd6', '#ce9178', '#b5cea8', '#d4d4aa', '#c586c0', '#9cdcfe', '#dcdcaa'];

class ConnectionStore extends EventEmitter {
  private connections: Map<string, ManagedConnection> = new Map();
  private colorIndex = 0;

  async connect(config: ConnectionConfig): Promise<ManagedConnection> {
    // If already connected with this id, disconnect first
    if (this.connections.has(config.id)) {
      await this.disconnect(config.id);
    }

    const opts: any = { servers: config.servers };

    switch (config.authMethod) {
      case 'token':
        opts.token = config.token;
        break;
      case 'userpass':
        opts.user = config.user;
        opts.pass = config.pass;
        break;
      case 'nkey':
        if (config.nkeySeed) {
          opts.authenticator = nkeyAuthenticator(new TextEncoder().encode(config.nkeySeed));
        }
        break;
      case 'jwt':
        if (config.creds) {
          opts.authenticator = credsAuthenticator(new TextEncoder().encode(config.creds));
        }
        break;
    }

    if (config.tls) {
      opts.tls = { rejectUnauthorized: false };
    }

    const nc = await connect(opts);
    const subMgr = new SubscriptionManager(nc, config.id);
    const color = COLORS[this.colorIndex++ % COLORS.length];

    const managed: ManagedConnection = { id: config.id, config, nc, subscriptionManager: subMgr, color };
    this.connections.set(config.id, managed);

    // Monitor connection status
    (async () => {
      for await (const s of nc.status()) {
        this.emit('status-change', config.id, this.getStatus(config.id));
      }
    })().catch(() => {});

    this.emit('connection-added', config.id, managed);
    this.emit('status-change', config.id, this.getStatus(config.id));

    return managed;
  }

  async disconnect(connId: string): Promise<void> {
    const managed = this.connections.get(connId);
    if (!managed) return;

    managed.subscriptionManager.stop();
    try { await managed.nc.drain(); } catch {}
    this.connections.delete(connId);
    this.emit('connection-removed', connId);
    this.emit('status-change', connId, { id: connId, connected: false });
  }

  async disconnectAll(): Promise<void> {
    for (const id of [...this.connections.keys()]) {
      await this.disconnect(id);
    }
  }

  get(connId: string): ManagedConnection | undefined {
    return this.connections.get(connId);
  }

  getConnection(connId: string): NatsConnection | null {
    return this.connections.get(connId)?.nc || null;
  }

  getAll(): ManagedConnection[] {
    return [...this.connections.values()];
  }

  getStatus(connId: string): any {
    const managed = this.connections.get(connId);
    if (!managed) return { id: connId, connected: false };
    const info = managed.nc.info;
    return {
      id: connId,
      name: managed.config.name,
      connected: !managed.nc.isClosed(),
      server: info ? `${info.host}:${info.port}` : managed.config.servers[0],
      color: managed.color,
      servers: managed.config.servers,
      subscriptions: managed.subscriptionManager.subjects,
    };
  }

  getAllStatuses(): any[] {
    return [...this.connections.keys()].map(id => this.getStatus(id));
  }

  async getClusterInfo(connId: string): Promise<any> {
    const managed = this.connections.get(connId);
    if (!managed || managed.nc.isClosed()) return null;

    const info = managed.nc.info;
    if (!info) return null;

    // Try to fetch monitoring info via HTTP if we can guess the monitoring port
    // The server info contains connect_urls which lists cluster peers
    const clusterInfo: any = {
      connId,
      serverName: info.server_name,
      serverId: info.server_id,
      version: info.version,
      proto: info.proto,
      host: info.host,
      port: info.port,
      maxPayload: info.max_payload,
      clientId: info.client_id,
      clientIp: info.client_ip,
      cluster: info.cluster,
      jetstream: info.jetstream,
      headers: info.headers,
      authRequired: info.auth_required,
      tlsRequired: info.tls_required,
      connectUrls: info.connect_urls || [],
      ldm: info.ldm,
    };

    return clusterInfo;
  }
}

export const connectionStore = new ConnectionStore();
