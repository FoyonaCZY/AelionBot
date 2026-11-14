// Starts the relay from the command line or a service manager. Settings come from flags or the environment:
//   node relay.cjs --port 8790 --host 127.0.0.1 --public ./public
//   RELAY_PORT, RELAY_HOST, RELAY_PUBLIC, RELAY_DAILY_GB, RELAY_TRUST_PROXY=1
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startRelay } from './relay';

const { values } = parseArgs({
  options: {
    port: { type: 'string' },
    host: { type: 'string' },
    public: { type: 'string' },
    'daily-gb': { type: 'string' },
    'trust-proxy': { type: 'boolean' },
  },
});
const env = process.env;
const publicDir = values.public || env.RELAY_PUBLIC || join(__dirname, 'public');
const dailyGb = Number(values['daily-gb'] || env.RELAY_DAILY_GB || 4);
void main();
async function main() {
  const relay = await startRelay({
    port: Number(values.port || env.RELAY_PORT || 8790),
    host: values.host || env.RELAY_HOST || '127.0.0.1',
    publicDir: existsSync(publicDir) ? publicDir : undefined,
    dailyBytesPerRoom: Number.isFinite(dailyGb) && dailyGb > 0 ? dailyGb * 1024 ** 3 : 0,
    trustProxy: values['trust-proxy'] || env.RELAY_TRUST_PROXY === '1',
    log: (line) => console.log(line),
  });
  if (!existsSync(publicDir)) console.log(`no phone app at ${publicDir}; only the relay endpoints answer`);
  const stop = () => void relay.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
