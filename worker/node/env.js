// Local settings for the Node adapter: a .dev.vars file (KEY=VALUE lines,
// gitignored) and, for simnet runs, the studio's secrets file.
import { existsSync, readFileSync } from 'node:fs';

/** Parse KEY=VALUE lines (# comments, optional quotes). */
export const parseDevVars = (text) => {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m === null || line.trim().startsWith('#')) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
};

export const readDevVars = (path) => (path !== undefined && existsSync(path) ? parseDevVars(readFileSync(path, 'utf8')) : {});

/** STUDIO_DATA_KEY from a studio secrets file (.secrets/studio.json or a simnet bootstrap's studio.json). */
export const dataKeyFromStudio = (path) => {
  const body = JSON.parse(readFileSync(path, 'utf8'));
  const hex = body?.data?.privateKey;
  if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`${path} has no data.privateKey`);
  return hex;
};
