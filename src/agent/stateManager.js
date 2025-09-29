import fs from 'fs/promises';
import path from 'path';

const AGENT_DATA_DIR = path.join(process.cwd(), 'agent_data');
const STATE_FILE = path.join(AGENT_DATA_DIR, 'state.json');

export function getStateFilePath() {
  return STATE_FILE;
}

export async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { lastRun: {} };
    }
    throw error;
  }
}

export async function saveState(state) {
  await fs.mkdir(AGENT_DATA_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}
