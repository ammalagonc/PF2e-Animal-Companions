import { compilePack } from "@foundryvtt/foundryvtt-cli";
import { existsSync } from "fs";
import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from 'url';

// Clean output directory, or create build directory
const outDir = path.resolve(process.cwd(), "build");
if (existsSync(outDir)) {
    const filesToClean = (await fs.readdir(outDir)).map((dirName) => path.resolve(outDir, dirName));
    for (const file of filesToClean) {
        await fs.rm(file, { recursive: true });
    }
} else {
    await fs.mkdir(outDir);
}

// Build packs
const packFolders = await fs.readdir("packs");
for (const pack of packFolders) {
    await compilePack(`packs/${pack}`, path.resolve(outDir, `packs/${pack}`));
}

// If there are any 'sf-' prefixed packs, ensure there are no duplicate item names
// across those packs. Only run starfind integration when no duplicates exist.
const sfPackFolders = packFolders.filter((p) => p.startsWith("sf-"));
if (sfPackFolders.length > 0) {
    const nameCounts = new Map();
    for (const pack of sfPackFolders) {
        const packPath = path.join("packs", pack);
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
                    nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
                } catch (err) {
                    console.warn(`Warning parsing ${packPath}/${file}: ${err.message}`);
                }
            }
        } catch (err) {
            console.warn(`Warning reading pack folder ${packPath}: ${err.message}`);
        }
    }

    const duplicates = [...nameCounts.entries()].filter(([_, c]) => c > 1);
    if (duplicates.length === 0) {
        const sfPath = path.resolve(process.cwd(), 'starfind.mjs');
        if (existsSync(sfPath)) {
            try {
                const mod = await import(pathToFileURL(sfPath).href);
                if (mod && typeof mod.default === 'function') await mod.default();
                else if (mod && typeof mod.run === 'function') await mod.run();
                else if (typeof mod === 'function') await mod();
                console.info(`Executed starfind from ${sfPath}`);
            } catch (err) {
                console.warn(`Failed to execute starfind at ${sfPath}: ${err.message}`);
            }
        } else {
            console.info('No starfind.mjs found in repository root to run.');
        }
    } else {
        console.info('Detected duplicate items across sf- packs; skipping starfind integration.');
    }
}

// Copy files and folders to output
const files = ["art", "lang","scripts", "licenses", "module.json"];
for (const file of files) {
    await fs.cp(file, path.resolve(outDir, file), { recursive: true });
}
