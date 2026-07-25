import fs from 'fs/promises';
import path from 'path';

async function main() {
  const packsRoot = path.resolve(process.cwd(), 'packs');
  const packFolders = await fs.readdir(packsRoot);
  const sfPacks = packFolders.filter((p) => p.startsWith('sf-'));
  if (sfPacks.length === 0) {
    console.log('No sf- packs found.');
    return;
  }

  const counts = new Map();
  const filesByName = new Map();

  for (const pack of sfPacks) {
    const packPath = path.join(packsRoot, pack);
    try {
      const files = await fs.readdir(packPath);
      for (const file of files) {
        if (!file.toLowerCase().endsWith('.json')) continue;
        try {
          const content = await fs.readFile(path.join(packPath, file), 'utf8');
          const obj = JSON.parse(content);
          const name = obj && (obj.name || obj.title || (obj.meta && obj.meta.name));
          if (!name) continue;
          const key = String(name).trim();
          counts.set(key, (counts.get(key) || 0) + 1);
          const arr = filesByName.get(key) || [];
          arr.push(path.join(pack, file));
          filesByName.set(key, arr);
        } catch (err) {
          console.warn(`Warning parsing ${pack}/${file}: ${err.message}`);
        }
      }
    } catch (err) {
      console.warn(`Warning reading pack folder ${pack}: ${err.message}`);
    }
  }

  const duplicates = [...counts.entries()].filter(([_, c]) => c > 1);
  if (duplicates.length === 0) {
    console.log('No duplicate item names found across sf- packs.');
    return;
  }

  console.log(`Found ${duplicates.length} duplicate name(s):`);
  for (const [name] of duplicates) {
    const list = filesByName.get(name) || [];
    console.log(`- ${name} (occurrences: ${list.length})`);
    for (const p of list) console.log(`    ${p}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
