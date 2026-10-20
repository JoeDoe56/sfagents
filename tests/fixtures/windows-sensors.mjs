import readline from 'node:readline';
const mode = process.argv[2];
let reads = 0;
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  if (line !== 'read') process.exit(2);
  if (mode === 'hang') return;
  if (mode === 'crash') process.exit(1);
  if (mode === 'malformed') { console.log('{"sensors":[{}]}'); return; }
  reads++;
  console.log(JSON.stringify({ sensors: [{ hardwareId: '/intelcpu/0', hardware: String(process.pid), id: '/intelcpu/0/load/0', name: 'CPU Total', type: 'Load', value: reads }], processes: 42, hint: process.env.OPENROUTER_API_KEY || process.env.NODE_OPTIONS || null }));
});
