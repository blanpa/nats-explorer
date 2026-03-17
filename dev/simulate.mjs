import { connect, JSONCodec } from 'nats';

const jc = JSONCodec();

// Helper functions
const rand = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.floor(rand(min, max));
const pick = (arr) => arr[randInt(0, arr.length)];
const drift = (base, range) => base + (Math.random() - 0.5) * range;

// Simulated device states
const state = {
  robot01: { x: 423.5, y: -112.3, z: 890.1, motor1: 42.3, motor2: 38.7, motor3: 45.1, cycles: 89234 },
  robot02: { x: 210.0, y: 330.5, z: 750.2, motor1: 39.1, motor2: 41.2, motor3: 37.8, cycles: 67891 },
  cnc01: { rpm: 8500, load: 62, temp: 48.3, vibration: 1.2, parts: 234, toolWear: 67 },
  conveyor01: { speed: 1.2, items: 4521, jams: 0 },
  agv01: { x: 12.4, y: 8.7, battery: 78, speed: 0.8, heading: 127.5 },
  tempSensor01: { value: 22.4 },
  tempSensor02: { value: 21.3 },
  energy: { power: 342.5, pf: 0.97, todayKwh: 2845.7 },
  hvac: { indoor: 22.4, outdoor: 8.3, humidity: 45.2 },
  line1: { rate: 112, produced: 892, rejected: 12 },
  line2: { rate: 82, produced: 634, rejected: 5 },
};

async function main() {
  console.log('Connecting to NATS simulator...');
  const nc = await connect({ servers: 'nats://localhost:4230' });
  console.log('Connected! Simulating UNS data... (Ctrl+C to stop)\n');

  let tick = 0;

  const interval = setInterval(async () => {
    tick++;
    const now = new Date().toISOString();

    // === Fast updates (every tick = 1s) ===

    // Robot positions (simulate movement)
    state.robot01.x = drift(state.robot01.x, 5);
    state.robot01.y = drift(state.robot01.y, 5);
    state.robot01.z = drift(state.robot01.z, 3);
    nc.publish('uns.acme.factory-berlin.assembly.line-1.robot-01.position', jc.encode({
      x: +state.robot01.x.toFixed(1), y: +state.robot01.y.toFixed(1), z: +state.robot01.z.toFixed(1),
      a: drift(45, 2), b: drift(0, 1), c: drift(90, 2), unit: 'mm/deg', timestamp: now,
    }));

    state.robot02.x = drift(state.robot02.x, 5);
    state.robot02.y = drift(state.robot02.y, 5);
    state.robot02.z = drift(state.robot02.z, 3);
    nc.publish('uns.acme.factory-berlin.assembly.line-1.robot-02.position', jc.encode({
      x: +state.robot02.x.toFixed(1), y: +state.robot02.y.toFixed(1), z: +state.robot02.z.toFixed(1),
      a: drift(30, 2), b: drift(0, 1), c: drift(180, 2), unit: 'mm/deg', timestamp: now,
    }));

    // CNC spindle data
    state.cnc01.rpm = drift(state.cnc01.rpm, 200);
    state.cnc01.load = Math.max(0, Math.min(100, drift(state.cnc01.load, 5)));
    state.cnc01.vibration = Math.max(0, drift(state.cnc01.vibration, 0.3));
    nc.publish('uns.acme.factory-berlin.machining.line-2.cnc-01.spindle', jc.encode({
      rpm: Math.round(state.cnc01.rpm), load: +state.cnc01.load.toFixed(1),
      temperature: +drift(state.cnc01.temp, 0.5).toFixed(1),
      vibration: +state.cnc01.vibration.toFixed(2), timestamp: now,
    }));

    // Conveyor
    if (tick % 2 === 0) {
      state.conveyor01.items += randInt(0, 3);
      nc.publish('uns.acme.factory-berlin.assembly.line-1.conveyor-01.speed', jc.encode({
        value: +drift(1.2, 0.05).toFixed(2), unit: 'm/s', setpoint: 1.2, timestamp: now,
      }));
      nc.publish('uns.acme.factory-berlin.assembly.line-1.conveyor-01.status', jc.encode({
        state: 'running', items_count: state.conveyor01.items, jams_today: state.conveyor01.jams, timestamp: now,
      }));
    }

    // AGV position
    state.agv01.x = drift(state.agv01.x, 0.5);
    state.agv01.y = drift(state.agv01.y, 0.5);
    state.agv01.heading = (state.agv01.heading + rand(-2, 2) + 360) % 360;
    if (tick % 60 === 0) state.agv01.battery = Math.max(10, state.agv01.battery - 0.1);
    nc.publish('uns.acme.factory-berlin.logistics.warehouse.agv-01.position', jc.encode({
      x: +state.agv01.x.toFixed(1), y: +state.agv01.y.toFixed(1),
      floor: 1, zone: 'A', heading: +state.agv01.heading.toFixed(1), timestamp: now,
    }));
    nc.publish('uns.acme.factory-berlin.logistics.warehouse.agv-01.status', jc.encode({
      state: pick(['delivering', 'delivering', 'delivering', 'returning', 'loading']),
      battery: +state.agv01.battery.toFixed(1), speed: +drift(0.8, 0.2).toFixed(1),
      payload_kg: randInt(0, 80), destination: pick(['line-1.input', 'line-2.input', 'warehouse.staging']),
      timestamp: now,
    }));

    // === Medium updates (every 5s) ===
    if (tick % 5 === 0) {
      // Temperature sensors
      state.tempSensor01.value = drift(state.tempSensor01.value, 0.3);
      nc.publish('uns.acme.factory-berlin.assembly.line-1.sensor-temp-01.value', jc.encode({
        value: +state.tempSensor01.value.toFixed(1), unit: 'celsius', quality: 'good', timestamp: now,
      }));

      state.tempSensor02.value = drift(state.tempSensor02.value, 0.2);
      nc.publish('uns.acme.factory-berlin.machining.line-2.sensor-temp-02.value', jc.encode({
        value: +state.tempSensor02.value.toFixed(1), unit: 'celsius', quality: 'good', timestamp: now,
      }));

      // Robot temperatures
      state.robot01.motor1 = drift(state.robot01.motor1, 0.5);
      state.robot01.motor2 = drift(state.robot01.motor2, 0.5);
      state.robot01.motor3 = drift(state.robot01.motor3, 0.5);
      nc.publish('uns.acme.factory-berlin.assembly.line-1.robot-01.temperature', jc.encode({
        motor1: +state.robot01.motor1.toFixed(1), motor2: +state.robot01.motor2.toFixed(1),
        motor3: +state.robot01.motor3.toFixed(1), controller: +drift(35, 1).toFixed(1),
        unit: 'celsius', timestamp: now,
      }));

      // Robot status with cycle increment
      state.robot01.cycles += randInt(1, 5);
      nc.publish('uns.acme.factory-berlin.assembly.line-1.robot-01.status', jc.encode({
        state: 'running', mode: 'auto', uptime_h: 1247 + tick / 3600,
        cycle_count: state.robot01.cycles, last_error: null, timestamp: now,
      }));

      state.robot02.cycles += randInt(1, 4);
      nc.publish('uns.acme.factory-berlin.assembly.line-1.robot-02.status', jc.encode({
        state: 'running', mode: 'auto', uptime_h: 983 + tick / 3600,
        cycle_count: state.robot02.cycles, last_error: null, timestamp: now,
      }));

      // CNC status
      state.cnc01.parts += Math.random() > 0.7 ? 1 : 0;
      state.cnc01.toolWear = Math.min(100, state.cnc01.toolWear + rand(0, 0.05));
      nc.publish('uns.acme.factory-berlin.machining.line-2.cnc-01.status', jc.encode({
        state: 'running', mode: 'auto', program: 'OP-4523',
        parts_completed: state.cnc01.parts, tool_wear: +state.cnc01.toolWear.toFixed(1), timestamp: now,
      }));

      // Coolant
      nc.publish('uns.acme.factory-berlin.machining.line-2.cnc-01.coolant', jc.encode({
        flow: +drift(14.8, 0.5).toFixed(1), temperature: +drift(21.3, 0.3).toFixed(1),
        level: +drift(78, 1).toFixed(0), unit: 'l/min | celsius | percent', timestamp: now,
      }));

      // Energy
      state.energy.power = drift(state.energy.power, 15);
      state.energy.todayKwh += state.energy.power / 3600 * 5;
      nc.publish('uns.acme.factory-berlin.energy.main-meter.power', jc.encode({
        active_kw: +state.energy.power.toFixed(1), reactive_kvar: +drift(87, 5).toFixed(1),
        power_factor: +drift(0.97, 0.01).toFixed(3),
        voltage_v: [+drift(400, 1).toFixed(1), +drift(400, 1).toFixed(1), +drift(400, 1).toFixed(1)],
        current_a: [+drift(495, 10).toFixed(1), +drift(498, 10).toFixed(1), +drift(493, 10).toFixed(1)],
        timestamp: now,
      }));

      // HVAC
      state.hvac.indoor = drift(state.hvac.indoor, 0.1);
      state.hvac.humidity = drift(state.hvac.humidity, 0.3);
      nc.publish('uns.acme.factory-berlin.environment.hvac.temperature', jc.encode({
        indoor: +state.hvac.indoor.toFixed(1), outdoor: +drift(state.hvac.outdoor, 0.2).toFixed(1),
        setpoint: 22.0, unit: 'celsius', timestamp: now,
      }));
      nc.publish('uns.acme.factory-berlin.environment.hvac.humidity', jc.encode({
        indoor: +state.hvac.humidity.toFixed(1), outdoor: +drift(78, 2).toFixed(1),
        setpoint: 45.0, unit: 'percent', timestamp: now,
      }));

      // PLC status
      nc.publish('uns.acme.factory-berlin.assembly.line-1.plc-01.status', jc.encode({
        state: 'run', scan_time_ms: +drift(2.3, 0.2).toFixed(1),
        memory_usage: randInt(40, 55), io_errors: 0, timestamp: now,
      }));
      nc.publish('uns.acme.factory-berlin.machining.line-2.plc-02.status', jc.encode({
        state: 'run', scan_time_ms: +drift(1.8, 0.15).toFixed(1),
        memory_usage: randInt(35, 45), io_errors: 0, timestamp: now,
      }));
    }

    // === Slow updates (every 30s) ===
    if (tick % 30 === 0) {
      // Production rates
      state.line1.produced += randInt(1, 4);
      if (Math.random() > 0.9) state.line1.rejected++;
      state.line1.rate = Math.round(drift(112, 8));
      nc.publish('uns.acme.factory-berlin.quality.line-1.current-batch', jc.encode({
        batch_id: 'B-2025-0316-001', product: 'Assembly-A', started: '2025-03-16T06:00:00Z',
        produced: state.line1.produced, rejected: state.line1.rejected,
        quality: +((1 - state.line1.rejected / state.line1.produced) * 100).toFixed(1), timestamp: now,
      }));

      state.line2.produced += randInt(1, 3);
      if (Math.random() > 0.95) state.line2.rejected++;
      state.line2.rate = Math.round(drift(82, 5));
      nc.publish('uns.acme.factory-berlin.quality.line-2.current-batch', jc.encode({
        batch_id: 'B-2025-0316-002', product: 'Part-X7', started: '2025-03-16T06:00:00Z',
        produced: state.line2.produced, rejected: state.line2.rejected,
        quality: +((1 - state.line2.rejected / state.line2.produced) * 100).toFixed(1), timestamp: now,
      }));

      // OEE Metrics
      nc.publish('metrics.oee.line-1', jc.encode({
        oee: +drift(87.3, 2).toFixed(1), availability: +drift(95.2, 1).toFixed(1),
        performance: +drift(91.8, 2).toFixed(1), quality: +drift(99.8, 0.3).toFixed(1), timestamp: now,
      }));
      nc.publish('metrics.oee.line-2', jc.encode({
        oee: +drift(92.1, 1.5).toFixed(1), availability: +drift(97.5, 0.8).toFixed(1),
        performance: +drift(94.5, 1.5).toFixed(1), quality: +drift(99.9, 0.2).toFixed(1), timestamp: now,
      }));
      nc.publish('metrics.energy.factory', jc.encode({
        consumption_kw: +state.energy.power.toFixed(1),
        cost_eur_h: +(state.energy.power * 0.12).toFixed(2),
        co2_kg_h: +(state.energy.power * 0.4).toFixed(1), timestamp: now,
      }));
      nc.publish('metrics.production.line-1', jc.encode({
        rate: state.line1.rate, target: 120, efficiency: +(state.line1.rate / 120 * 100).toFixed(1), timestamp: now,
      }));
      nc.publish('metrics.production.line-2', jc.encode({
        rate: state.line2.rate, target: 85, efficiency: +(state.line2.rate / 85 * 100).toFixed(1), timestamp: now,
      }));

      nc.publish('uns.acme.factory-berlin.energy.main-meter.consumption', jc.encode({
        today_kwh: +state.energy.todayKwh.toFixed(1), month_kwh: +(48923 + state.energy.todayKwh).toFixed(1),
        year_kwh: +(289345 + state.energy.todayKwh).toFixed(1), timestamp: now,
      }));
    }

    // === Random events (probabilistic) ===

    // Occasional vibration warning
    if (Math.random() < 0.005) {
      const vib = +drift(4.0, 0.8).toFixed(2);
      nc.publish('events.alarm.line-2.cnc-01', jc.encode({
        alarm_id: 'ALM-004', severity: vib > 4.5 ? 'critical' : 'warning',
        message: `Vibration level ${vib} mm/s ${vib > 4.5 ? 'EXCEEDED' : 'approaching'} threshold`,
        value: vib, threshold: 4.5, timestamp: now,
      }));
    }

    // Occasional production event
    if (Math.random() < 0.01) {
      nc.publish('events.production.line-1.quality-check', jc.encode({
        result: Math.random() > 0.1 ? 'pass' : 'fail',
        measurements: { dim_a: +drift(50.0, 0.05).toFixed(3), dim_b: +drift(25.0, 0.03).toFixed(3) },
        part_id: `P-${Date.now()}`, timestamp: now,
      }));
    }

    // Occasional audit log
    if (tick % 60 === 0) {
      nc.publish('audit.system.heartbeat', jc.encode({
        source: 'uns-simulator', uptime_s: tick,
        messages_published: tick * 15, timestamp: now,
      }));
    }

    // Status log every 30s
    if (tick % 30 === 0) {
      process.stdout.write(`\r  Tick ${tick} | ~${tick * 15} messages published`);
    }

  }, 1000);

  // Handle shutdown
  const shutdown = async () => {
    console.log('\n\nShutting down simulator...');
    clearInterval(interval);
    await nc.drain();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('Simulator failed:', err.message);
  process.exit(1);
});
