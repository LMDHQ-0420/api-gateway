import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { prepareProviders } from '../routing.mjs';

const configPath = resolve(process.env.PROVIDERS_FILE || 'providers.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
prepareProviders(config.providers);
for (const provider of config.providers) {
  if (provider.enabled === false) continue;
  if (typeof provider.keysFile !== 'string' || !provider.keysFile.trim()) throw new Error(`厂商 ${provider.id} 缺少 keysFile`);
  const path = resolve(dirname(configPath), provider.keysFile);
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, `# ${provider.id}: 每行填写一个官方 API key。\n`, { flag: 'wx', mode: 0o600 });
    console.log(`${provider.id}: key file created`);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    console.log(`${provider.id}: existing key file preserved`);
  }
}
