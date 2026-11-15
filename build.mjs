import { compilePack } from "@foundryvtt/foundryvtt-cli";
import { existsSync } from "fs";
import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";

const outDir = path.resolve(process.cwd(), "build");
if (existsSync(outDir)) {
    const filesToClean = (await fs.readdir(outDir))
        .map(dirName => path.resolve(outDir, dirName));
    for (const file of filesToClean) {
        await fs.rm(file, { recursive: true });
    }
} else {
    await fs.mkdir(outDir);
}

const packFolders = await fs.readdir("packs");
for (const pack of packFolders) {
    await compilePack(`packs/${pack}`, path.resolve(outDir, `packs/${pack}`));
}

const sfPackFolders = packFolders.filter(pack => pack.startsWith("sf-"));
if (sfPackFolders.length > 0) {
    const nameCounts = new Map();
    for (const pack of sfPackFolders) {
        const packPath = path.join("packs", pack);
        const files = await fs.readdir(packPath);
        for (const file of files) {
            if (!file.toLowerCase().endsWith(".json")) continue;
            const content = await fs.readFile(path.join(packPath, file), "utf8");
            const item = JSON.parse(content);
            const name = item && (item.name || item.title || (item.meta && item.meta.name));
            if (!name) continue;
            const key = String(name).trim();
            nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
        }
    }

    const duplicateCount = [...nameCounts.values()].filter(count => count > 1).length;
    if (duplicateCount > 0) {
        console.warn(`Detected ${duplicateCount} duplicate item name(s) across sf- packs.`);
    }

    const starfindPath = path.resolve(process.cwd(), "starfind.mjs");
    if (existsSync(starfindPath)) {
        await import(pathToFileURL(starfindPath).href);
        console.info(`Executed Starfinder item sync from ${starfindPath}`);
    } else {
        console.info("No starfind.mjs found in repository root.");
    }
}

const files = ["art", "lang", "scripts", "licenses", "module.json"];
for (const file of files) {
    await fs.cp(file, path.resolve(outDir, file), { recursive: true });
}
