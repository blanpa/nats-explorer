import { connect, StringCodec, JSONCodec } from 'nats';

const sc = StringCodec();
const jc = JSONCodec();

async function main() {
  console.log('Connecting to NATS...');
  const nc = await connect({ servers: process.env.NATS_URL ?? 'nats://localhost:4230' });
  const jsm = await nc.jetstreamManager();
  const js = nc.jetstream();

  console.log('\n=== Creating Streams ===\n');

  // 1. UNS Stream - Unified Namespace (ISA-95 hierarchy)
  try {
    await jsm.streams.add({
      name: 'UNS',
      subjects: ['uns.>'],
      retention: 'limits',
      max_msgs: 100000,
      max_age: 24 * 60 * 60 * 1e9, // 24h in nanos
      storage: 'file',
      description: 'Unified Namespace - ISA-95 hierarchy for all plant data',
    });
    console.log('Created stream: UNS (uns.>)');
  } catch (e) {
    console.log('Stream UNS:', e.message);
  }

  // 2. Events Stream
  try {
    await jsm.streams.add({
      name: 'EVENTS',
      subjects: ['events.>'],
      retention: 'limits',
      max_msgs: 50000,
      max_age: 7 * 24 * 60 * 60 * 1e9, // 7 days
      storage: 'file',
      description: 'Machine events, alarms, and notifications',
    });
    console.log('Created stream: EVENTS (events.>)');
  } catch (e) {
    console.log('Stream EVENTS:', e.message);
  }

  // 3. Commands Stream
  try {
    await jsm.streams.add({
      name: 'COMMANDS',
      subjects: ['cmd.>'],
      retention: 'workqueue',
      max_msgs: 10000,
      storage: 'file',
      description: 'Command queue for machine control',
    });
    console.log('Created stream: COMMANDS (cmd.>)');
  } catch (e) {
    console.log('Stream COMMANDS:', e.message);
  }

  // 4. Metrics Stream
  try {
    await jsm.streams.add({
      name: 'METRICS',
      subjects: ['metrics.>'],
      retention: 'limits',
      max_msgs: 200000,
      max_age: 3 * 24 * 60 * 60 * 1e9, // 3 days
      storage: 'file',
      description: 'Aggregated metrics and KPIs',
    });
    console.log('Created stream: METRICS (metrics.>)');
  } catch (e) {
    console.log('Stream METRICS:', e.message);
  }

  // 5. Audit Stream
  try {
    await jsm.streams.add({
      name: 'AUDIT',
      subjects: ['audit.>'],
      retention: 'limits',
      max_msgs: 500000,
      max_age: 30 * 24 * 60 * 60 * 1e9, // 30 days
      storage: 'file',
      description: 'Audit log for compliance and traceability',
    });
    console.log('Created stream: AUDIT (audit.>)');
  } catch (e) {
    console.log('Stream AUDIT:', e.message);
  }

  // Create consumers
  console.log('\n=== Creating Consumers ===\n');

  try {
    await jsm.consumers.add('UNS', {
      durable_name: 'historian',
      description: 'Historian database consumer',
      deliver_policy: 'all',
      ack_policy: 'explicit',
      filter_subject: 'uns.>',
    });
    console.log('Created consumer: UNS/historian');
  } catch (e) {
    console.log('Consumer historian:', e.message);
  }

  try {
    await jsm.consumers.add('UNS', {
      durable_name: 'dashboard',
      description: 'Dashboard real-time consumer',
      deliver_policy: 'last_per_subject',
      ack_policy: 'none',
    });
    console.log('Created consumer: UNS/dashboard');
  } catch (e) {
    console.log('Consumer dashboard:', e.message);
  }

  try {
    await jsm.consumers.add('EVENTS', {
      durable_name: 'alert-service',
      description: 'Alert processing service',
      deliver_policy: 'new',
      ack_policy: 'explicit',
      filter_subject: 'events.alarm.>',
    });
    console.log('Created consumer: EVENTS/alert-service');
  } catch (e) {
    console.log('Consumer alert-service:', e.message);
  }

  try {
    await jsm.consumers.add('COMMANDS', {
      durable_name: 'plc-gateway',
      description: 'PLC gateway command processor',
      deliver_policy: 'all',
      ack_policy: 'explicit',
      max_deliver: 3,
    });
    console.log('Created consumer: COMMANDS/plc-gateway');
  } catch (e) {
    console.log('Consumer plc-gateway:', e.message);
  }

  // KV Buckets
  console.log('\n=== Creating KV Buckets ===\n');

  // Device registry
  const kvDevices = await js.views.kv('device-registry', {
    description: 'Device metadata and configuration',
    history: 5,
    max_bytes: 10 * 1024 * 1024,
  });
  console.log('Created KV: device-registry');

  const devices = {
    'robot-01': {
      type: 'robot',
      manufacturer: 'KUKA',
      model: 'KR 16-2',
      serial: 'KR16-2024-0451',
      firmware: 'v8.3.12',
      location: 'line-1.cell-a',
      status: 'running',
      installDate: '2023-06-15',
      lastMaintenance: '2024-11-20',
    },
    'robot-02': {
      type: 'robot',
      manufacturer: 'ABB',
      model: 'IRB 6700',
      serial: 'IRB67-2024-0892',
      firmware: 'v7.1.4',
      location: 'line-1.cell-b',
      status: 'running',
      installDate: '2023-08-22',
      lastMaintenance: '2024-12-05',
    },
    'cnc-01': {
      type: 'cnc',
      manufacturer: 'DMG MORI',
      model: 'NLX 2500',
      serial: 'NLX25-2023-1123',
      firmware: 'v4.2.1',
      location: 'line-2.station-1',
      status: 'running',
      installDate: '2022-03-10',
      lastMaintenance: '2025-01-15',
    },
    'cnc-02': {
      type: 'cnc',
      manufacturer: 'Haas',
      model: 'ST-20Y',
      serial: 'ST20Y-2024-0334',
      firmware: 'v3.8.7',
      location: 'line-2.station-2',
      status: 'maintenance',
      installDate: '2024-01-20',
      lastMaintenance: '2025-03-10',
    },
    'conveyor-01': {
      type: 'conveyor',
      manufacturer: 'Siemens',
      model: 'S120',
      serial: 'S120-2023-5567',
      firmware: 'v5.6.2',
      location: 'line-1.transport',
      status: 'running',
      installDate: '2023-04-01',
      lastMaintenance: '2024-10-30',
    },
    'sensor-temp-01': {
      type: 'sensor',
      manufacturer: 'Endress+Hauser',
      model: 'iTHERM TM411',
      serial: 'TM411-0891',
      firmware: 'v2.1.0',
      location: 'line-1.cell-a.ambient',
      status: 'running',
      installDate: '2023-06-15',
    },
    'sensor-temp-02': {
      type: 'sensor',
      manufacturer: 'Endress+Hauser',
      model: 'iTHERM TM411',
      serial: 'TM411-0892',
      firmware: 'v2.1.0',
      location: 'line-2.station-1.coolant',
      status: 'running',
      installDate: '2023-06-15',
    },
    'plc-01': {
      type: 'plc',
      manufacturer: 'Siemens',
      model: 'S7-1500',
      serial: 'S7-2023-7789',
      firmware: 'v2.9.4',
      location: 'line-1.control',
      status: 'running',
      installDate: '2022-11-05',
      lastMaintenance: '2024-08-20',
    },
    'plc-02': {
      type: 'plc',
      manufacturer: 'Beckhoff',
      model: 'CX5130',
      serial: 'CX51-2024-1234',
      firmware: 'v3.1.4088',
      location: 'line-2.control',
      status: 'running',
      installDate: '2024-02-14',
    },
    'agv-01': {
      type: 'agv',
      manufacturer: 'MiR',
      model: 'MiR250',
      serial: 'MIR250-2024-0223',
      firmware: 'v3.0.1',
      location: 'warehouse.zone-a',
      status: 'running',
      installDate: '2024-05-10',
      battery: 78,
    },
  };

  for (const [id, meta] of Object.entries(devices)) {
    await kvDevices.put(id, jc.encode(meta));
  }
  console.log(`  Seeded ${Object.keys(devices).length} devices`);

  // Production config
  const kvConfig = await js.views.kv('production-config', {
    description: 'Production parameters and setpoints',
    history: 10,
    max_bytes: 5 * 1024 * 1024,
  });
  console.log('Created KV: production-config');

  const configs = {
    'line-1.target-rate': JSON.stringify({ value: 120, unit: 'parts/hour', updatedBy: 'operator-mueller', updatedAt: '2025-03-16T08:00:00Z' }),
    'line-1.quality-threshold': JSON.stringify({ value: 98.5, unit: 'percent', updatedBy: 'quality-eng', updatedAt: '2025-03-15T14:30:00Z' }),
    'line-2.target-rate': JSON.stringify({ value: 85, unit: 'parts/hour', updatedBy: 'operator-schmidt', updatedAt: '2025-03-16T06:00:00Z' }),
    'line-2.quality-threshold': JSON.stringify({ value: 99.0, unit: 'percent', updatedBy: 'quality-eng', updatedAt: '2025-03-14T10:00:00Z' }),
    'global.shift-schedule': JSON.stringify({ shifts: ['06:00-14:00', '14:00-22:00', '22:00-06:00'], timezone: 'Europe/Berlin' }),
    'global.maintenance-window': JSON.stringify({ day: 'Sunday', start: '06:00', end: '14:00', timezone: 'Europe/Berlin' }),
    'robot-01.speed-limit': JSON.stringify({ value: 250, unit: 'mm/s', safety: true }),
    'robot-02.speed-limit': JSON.stringify({ value: 300, unit: 'mm/s', safety: true }),
    'cnc-01.spindle-max-rpm': JSON.stringify({ value: 12000, unit: 'rpm' }),
    'cnc-01.coolant-flow-setpoint': JSON.stringify({ value: 15.0, unit: 'l/min' }),
  };

  for (const [key, value] of Object.entries(configs)) {
    await kvConfig.put(key, sc.encode(value));
  }
  console.log(`  Seeded ${Object.keys(configs).length} config entries`);

  // Alarm definitions
  const kvAlarms = await js.views.kv('alarm-definitions', {
    description: 'Alarm definitions and thresholds',
    history: 3,
  });
  console.log('Created KV: alarm-definitions');

  const alarms = {
    'ALM-001': { name: 'High Temperature', severity: 'warning', threshold: 85, unit: 'celsius', source: 'sensor-temp-*', action: 'notify-operator' },
    'ALM-002': { name: 'Critical Temperature', severity: 'critical', threshold: 95, unit: 'celsius', source: 'sensor-temp-*', action: 'emergency-stop' },
    'ALM-003': { name: 'Low Pressure', severity: 'warning', threshold: 2.5, unit: 'bar', source: 'sensor-pressure-*', action: 'notify-maintenance' },
    'ALM-004': { name: 'Vibration Exceeded', severity: 'warning', threshold: 4.5, unit: 'mm/s', source: 'sensor-vibration-*', action: 'schedule-maintenance' },
    'ALM-005': { name: 'Robot Collision Detected', severity: 'critical', threshold: null, source: 'robot-*', action: 'emergency-stop' },
    'ALM-006': { name: 'Conveyor Jam', severity: 'high', threshold: null, source: 'conveyor-*', action: 'stop-line' },
    'ALM-007': { name: 'Quality Below Threshold', severity: 'warning', threshold: 98.0, unit: 'percent', source: 'quality-*', action: 'notify-quality-eng' },
    'ALM-008': { name: 'AGV Battery Low', severity: 'warning', threshold: 20, unit: 'percent', source: 'agv-*', action: 'return-to-charger' },
  };

  for (const [id, def] of Object.entries(alarms)) {
    await kvAlarms.put(id, jc.encode(def));
  }
  console.log(`  Seeded ${Object.keys(alarms).length} alarm definitions`);

  // Object Store
  console.log('\n=== Creating Object Stores ===\n');

  const osReports = await js.views.os('production-reports', {
    description: 'Shift reports and production summaries',
  });
  console.log('Created Object Store: production-reports');

  // Create some sample report objects
  const reports = [
    {
      name: 'shift-report-2025-03-16-morning.json',
      content: JSON.stringify(
        {
          date: '2025-03-16',
          shift: 'morning',
          operator: 'Mueller',
          line1: { produced: 892, rejected: 12, oee: 87.3 },
          line2: { produced: 634, rejected: 5, oee: 92.1 },
          notes: 'CNC-02 scheduled for maintenance next shift',
        },
        null,
        2,
      ),
    },
    {
      name: 'shift-report-2025-03-15-afternoon.json',
      content: JSON.stringify(
        {
          date: '2025-03-15',
          shift: 'afternoon',
          operator: 'Schmidt',
          line1: { produced: 910, rejected: 8, oee: 89.5 },
          line2: { produced: 645, rejected: 3, oee: 93.8 },
          notes: 'All systems nominal',
        },
        null,
        2,
      ),
    },
    {
      name: 'maintenance-log-2025-03.csv',
      content: `Date,Device,Type,Duration_min,Technician,Notes
2025-03-01,cnc-01,preventive,120,Weber,Spindle bearing replaced
2025-03-05,robot-01,corrective,45,Fischer,Gripper recalibrated
2025-03-10,cnc-02,preventive,180,Weber,Full service - coolant system flushed
2025-03-12,conveyor-01,corrective,30,Braun,Belt tension adjusted
2025-03-15,plc-01,preventive,60,Fischer,Firmware update to v2.9.4`,
    },
    {
      name: 'quality-report-week-11.json',
      content: JSON.stringify(
        {
          week: 11,
          year: 2025,
          overall_quality: 98.7,
          by_line: { 'line-1': 98.2, 'line-2': 99.1 },
          top_defects: [
            { type: 'surface_scratch', count: 14, line: 'line-1' },
            { type: 'dimension_out_of_spec', count: 8, line: 'line-1' },
            { type: 'surface_scratch', count: 3, line: 'line-2' },
          ],
        },
        null,
        2,
      ),
    },
  ];

  for (const report of reports) {
    await osReports.put({ name: report.name }, readableFromString(report.content));
  }
  console.log(`  Seeded ${reports.length} reports`);

  // Seed some initial UNS messages
  console.log('\n=== Publishing Initial UNS Data ===\n');

  const now = new Date().toISOString();
  const unsMessages = [
    ['uns.acme.factory-berlin.assembly.line-1.robot-01.status', { state: 'running', mode: 'auto', uptime_h: 1247, cycle_count: 89234, last_error: null }],
    ['uns.acme.factory-berlin.assembly.line-1.robot-01.position', { x: 423.5, y: -112.3, z: 890.1, a: 45.0, b: 0.0, c: 90.0, unit: 'mm/deg' }],
    ['uns.acme.factory-berlin.assembly.line-1.robot-01.temperature', { motor1: 42.3, motor2: 38.7, motor3: 45.1, controller: 35.2, unit: 'celsius' }],
    ['uns.acme.factory-berlin.assembly.line-1.robot-02.status', { state: 'running', mode: 'auto', uptime_h: 983, cycle_count: 67891, last_error: null }],
    ['uns.acme.factory-berlin.assembly.line-1.conveyor-01.speed', { value: 1.2, unit: 'm/s', setpoint: 1.2 }],
    ['uns.acme.factory-berlin.assembly.line-1.conveyor-01.status', { state: 'running', items_count: 4521, jams_today: 0 }],
    ['uns.acme.factory-berlin.assembly.line-1.sensor-temp-01.value', { value: 22.4, unit: 'celsius', quality: 'good' }],
    ['uns.acme.factory-berlin.assembly.line-1.plc-01.status', { state: 'run', scan_time_ms: 2.3, memory_usage: 45, io_errors: 0 }],
    ['uns.acme.factory-berlin.machining.line-2.cnc-01.spindle', { rpm: 8500, load: 62, temperature: 48.3, vibration: 1.2 }],
    ['uns.acme.factory-berlin.machining.line-2.cnc-01.status', { state: 'running', mode: 'auto', program: 'OP-4523', parts_completed: 234, tool_wear: 67 }],
    ['uns.acme.factory-berlin.machining.line-2.cnc-01.coolant', { flow: 14.8, temperature: 21.3, level: 78, unit: 'l/min | celsius | percent' }],
    [
      'uns.acme.factory-berlin.machining.line-2.cnc-02.status',
      { state: 'maintenance', mode: 'manual', program: null, parts_completed: 0, reason: 'Scheduled preventive maintenance' },
    ],
    ['uns.acme.factory-berlin.machining.line-2.sensor-temp-02.value', { value: 21.3, unit: 'celsius', quality: 'good' }],
    ['uns.acme.factory-berlin.machining.line-2.plc-02.status', { state: 'run', scan_time_ms: 1.8, memory_usage: 38, io_errors: 0 }],
    ['uns.acme.factory-berlin.logistics.warehouse.agv-01.position', { x: 12.4, y: 8.7, floor: 1, zone: 'A', heading: 127.5 }],
    [
      'uns.acme.factory-berlin.logistics.warehouse.agv-01.status',
      { state: 'delivering', battery: 78, speed: 0.8, payload_kg: 45, destination: 'line-1.input' },
    ],
    [
      'uns.acme.factory-berlin.energy.main-meter.power',
      { active_kw: 342.5, reactive_kvar: 87.3, power_factor: 0.97, voltage_v: [400.1, 399.8, 400.3], current_a: [495.2, 498.1, 492.7] },
    ],
    ['uns.acme.factory-berlin.energy.main-meter.consumption', { today_kwh: 2845.7, month_kwh: 48923.4, year_kwh: 289345.1 }],
    ['uns.acme.factory-berlin.environment.hvac.temperature', { indoor: 22.4, outdoor: 8.3, setpoint: 22.0, unit: 'celsius' }],
    ['uns.acme.factory-berlin.environment.hvac.humidity', { indoor: 45.2, outdoor: 78.1, setpoint: 45.0, unit: 'percent' }],
    [
      'uns.acme.factory-berlin.quality.line-1.current-batch',
      { batch_id: 'B-2025-0316-001', product: 'Assembly-A', started: '2025-03-16T06:00:00Z', produced: 892, rejected: 12, quality: 98.7 },
    ],
    [
      'uns.acme.factory-berlin.quality.line-2.current-batch',
      { batch_id: 'B-2025-0316-002', product: 'Part-X7', started: '2025-03-16T06:00:00Z', produced: 634, rejected: 5, quality: 99.2 },
    ],
  ];

  for (const [subject, data] of unsMessages) {
    nc.publish(subject, jc.encode({ ...data, timestamp: now }));
  }
  console.log(`Published ${unsMessages.length} initial UNS messages`);

  // Some events
  const events = [
    [
      'events.alarm.line-1.robot-01',
      { alarm_id: 'ALM-004', severity: 'warning', message: 'Vibration level 3.8 mm/s approaching threshold', value: 3.8, threshold: 4.5, timestamp: now },
    ],
    ['events.production.line-1.batch-start', { batch_id: 'B-2025-0316-001', product: 'Assembly-A', target: 1000, timestamp: now }],
    ['events.maintenance.cnc-02.started', { type: 'preventive', technician: 'Weber', estimated_duration_min: 180, timestamp: now }],
    ['events.system.nats-explorer.connected', { user: 'dev', source: 'seed-script', timestamp: now }],
  ];

  for (const [subject, data] of events) {
    nc.publish(subject, jc.encode(data));
  }
  console.log(`Published ${events.length} events`);

  // Metrics
  const metrics = [
    ['metrics.oee.line-1', { oee: 87.3, availability: 95.2, performance: 91.8, quality: 99.8, timestamp: now }],
    ['metrics.oee.line-2', { oee: 92.1, availability: 97.5, performance: 94.5, quality: 99.9, timestamp: now }],
    ['metrics.energy.factory', { consumption_kw: 342.5, cost_eur_h: 41.1, co2_kg_h: 137.0, timestamp: now }],
    ['metrics.production.line-1', { rate: 112, target: 120, efficiency: 93.3, timestamp: now }],
    ['metrics.production.line-2', { rate: 82, target: 85, efficiency: 96.5, timestamp: now }],
  ];

  for (const [subject, data] of metrics) {
    nc.publish(subject, jc.encode(data));
  }
  console.log(`Published ${metrics.length} metrics`);

  await nc.flush();
  await nc.drain();
  console.log('\nSeed complete!');
}

function readableFromString(str) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(str));
      controller.close();
    },
  });
}

main().catch(err => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
