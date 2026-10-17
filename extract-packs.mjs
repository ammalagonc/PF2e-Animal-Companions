import { extractPack } from "@foundryvtt/foundryvtt-cli";
import { existsSync } from "fs";
import fs from "fs/promises";
import { execFileSync } from "child_process";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";

function toCrLf(text) {
    return text.replace(/\r\n|\n/g, "\r\n");
}

async function normalizeJsonFiles(targetDir) {
    const entries = await fs.readdir(targetDir, { withFileTypes: true });
    for (const entry of entries) {
        const entryPath = path.resolve(targetDir, entry.name);
        if (entry.isDirectory()) {
            await normalizeJsonFiles(entryPath);
            continue;
        }

        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;

        const currentContent = await fs.readFile(entryPath, "utf8");
        const normalizedContent = toCrLf(currentContent);
        if (currentContent !== normalizedContent) {
            await fs.writeFile(entryPath, normalizedContent);
        }
    }
}

const outDir = path.resolve(process.cwd(), "build");
const packsCompiled = path.resolve(outDir, "packs/");
if (!existsSync(packsCompiled)) {
    throw new Error(`Packs directory does not exist in the build: ${packsCompiled}`);
}

const packFolders = await fs.readdir(packsCompiled);

const replacer = (key, value) => {
      if (key === "createdTime") return undefined
      if (key === "modifiedTime") return undefined
      if (key === "lastModifiedBy") return undefined
      return value
}

async function getPackItems(packPath) {
    const items = new Map();
    const files = await fs.readdir(packPath, { withFileTypes: true });
    for (const file of files) {
        if (!file.isFile() || !file.name.toLowerCase().endsWith(".json")) continue;

        const filePath = path.resolve(packPath, file.name);
        const itemData = JSON.parse(await fs.readFile(filePath, "utf8"));
        if (!itemData._key?.startsWith("!items!")) continue;
        const itemId = itemData._id ?? itemData._key.slice("!items!".length);
        items.set(itemId, file.name);
    }
    return items;
}

async function getChangedPfItems(pfPacks) {
    const packPaths = pfPacks.map(pack => `${pack.path.replaceAll("\\", "/")}/`);
    const diffPaths = execFileSync("git", [
        "diff", "--name-only", "--no-renames", "HEAD", "--", ...packPaths
    ], { encoding: "utf8" });
    const untrackedPaths = execFileSync("git", [
        "ls-files", "--others", "--exclude-standard", "--", ...packPaths
    ], { encoding: "utf8" });
    const changedPaths = [...diffPaths.split(/\r?\n/), ...untrackedPaths.split(/\r?\n/)]
        .filter(Boolean);
    const changedItems = new Map(pfPacks.map(pack => [pack.name, new Set()]));

    for (const changedPath of changedPaths) {
        if (!changedPath.toLowerCase().endsWith(".json")) continue;

        const absolutePath = path.resolve(changedPath);
        const content = existsSync(absolutePath)
            ? await fs.readFile(absolutePath, "utf8")
            : execFileSync("git", ["show", `HEAD:${changedPath}`], { encoding: "utf8" });
        const itemData = JSON.parse(content);
        if (!itemData._key?.startsWith("!items!")) continue;
        const itemId = itemData._id ?? itemData._key.slice("!items!".length);

        for (const pack of pfPacks) {
            const relativePath = path.relative(path.resolve(pack.path), absolutePath);
            if (
                relativePath &&
                relativePath !== ".." &&
                !relativePath.startsWith(`..${path.sep}`) &&
                !path.isAbsolute(relativePath)
            ) {
                changedItems.get(pack.name).add(itemId);
                break;
            }
        }
    }

    return changedItems;
}

const args = process.argv.slice(2);
if (args.includes("all")) {
    const manifest = JSON.parse(await fs.readFile("module.json", "utf8"));
    const pfPacks = manifest.packs
        .filter(pack => pack.system === "pf2e")
        .map(pack => ({ name: pack.name, path: pack.path }));
    const changedItems = await getChangedPfItems(pfPacks);

    for (const pfPack of pfPacks) {
        const itemIds = changedItems.get(pfPack.name);
        if (itemIds.size === 0) continue;

        const targetPackPath = path.resolve(pfPack.path);
        await fs.mkdir(targetPackPath, { recursive: true });
        const tempPackRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pf2e-ac-extract-"));
        try {
            const extractedPackPath = path.join(tempPackRoot, pfPack.name);
            const compiledPackPath = path.resolve(packsCompiled, path.basename(pfPack.path));
            await extractPack(compiledPackPath, extractedPackPath, {
                jsonOptions: { replacer, space: 2 }
            });
            const extractedItems = await getPackItems(extractedPackPath);
            const targetItems = await getPackItems(targetPackPath);

            for (const itemId of itemIds) {
                const sourceFile = extractedItems.get(itemId);
                const targetFile = targetItems.get(itemId);
                if (sourceFile) {
                    const sourceFilePath = path.resolve(extractedPackPath, sourceFile);
                    const targetFilePath = path.resolve(targetPackPath, sourceFile);
                    if (targetFile && targetFile !== sourceFile) {
                        await fs.rm(path.resolve(targetPackPath, targetFile));
                    }
                    await fs.copyFile(sourceFilePath, targetFilePath);
                    const content = await fs.readFile(targetFilePath, "utf8");
                    await fs.writeFile(targetFilePath, toCrLf(content));
                    console.log(`Extracted changed PF2e item ${itemId} to ${targetFilePath}`);
                } else if (targetFile) {
                    await fs.rm(path.resolve(targetPackPath, targetFile));
                    console.log(`Removed deleted PF2e item ${itemId} from ${targetPackPath}`);
                }
            }
        } finally {
            await fs.rm(tempPackRoot, { recursive: true, force: true });
        }
    }

    console.log("Extracted changed PF2e items; other pack data was left unchanged.");

    const starfindPath = path.resolve(process.cwd(), "starfind.mjs");
    if (existsSync(starfindPath)) {
        console.log("Updating corresponding SF2e items...");
        await import(pathToFileURL(starfindPath).href);
    } else {
        console.warn("starfind.mjs not found in repository root; cannot update SF2e items.");
    }
} else {
    console.log("Cleaning packs");
    for (const pack of packFolders) {
        const files = await fs.readdir(`packs/${pack}`, { withFileTypes: true });
        const jsonFiles = files
            .filter((f) => f.isFile() && f.name.toLowerCase().endsWith(".json"))
            .map((f) => f.name);
        for (const file of jsonFiles) {
            await fs.rm(path.resolve("packs", pack, file));
        }
    }

    for (const pack of packFolders) {
        console.log(`Extracting pack: ${pack}`);
        await extractPack(path.resolve(packsCompiled, pack), `packs/${pack}`, {
            jsonOptions: { replacer, space: 2 }
        });
    }

    await normalizeJsonFiles(path.resolve(process.cwd(), "packs"));
    await normalizeJsonFiles(path.resolve(process.cwd(), "build", "packs"));
    console.log("Extraction Complete");
}
