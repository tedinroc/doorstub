import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const writePlan = (path, plan) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`);
};
