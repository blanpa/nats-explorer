/** Reply to $SRV.INFO from the NATS micro framework. */
export interface ServiceEndpoint {
  name: string;
  subject: string;
  queue_group?: string;
  metadata?: Record<string, string>;
}

export interface ServiceInfo {
  type: string;
  name: string;
  id: string;
  version: string;
  description?: string;
  metadata?: Record<string, string>;
  endpoints?: ServiceEndpoint[];
}

export interface ServiceEndpointStats {
  name: string;
  subject: string;
  queue_group?: string;
  num_requests: number;
  num_errors: number;
  last_error?: string;
  processing_time: number;
  average_processing_time: number;
  data?: unknown;
}

/** Reply to $SRV.STATS. */
export interface ServiceStats {
  type: string;
  name: string;
  id: string;
  version: string;
  started: string;
  endpoints?: ServiceEndpointStats[];
}

/** Reply to $SRV.PING. */
export interface ServicePing {
  type: string;
  name: string;
  id: string;
  version: string;
}
