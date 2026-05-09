import { appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const logDir = resolve(__dirname, '..', 'logs');
mkdirSync(logDir, { recursive: true });

const stamp = () => new Date().toISOString();

export function makeLogger(stepName) {
  const file = resolve(logDir, `${stepName}.log`);
  const write = (level, msg) => {
    const line = `[${stamp()}] ${level} ${msg}\n`;
    appendFileSync(file, line);
    if (level === 'ERROR') process.stderr.write(line);
    else process.stdout.write(line);
  };
  return {
    info: (m) => write('INFO ', m),
    warn: (m) => write('WARN ', m),
    error: (m) => write('ERROR', m),
    file,
  };
}
