import fs from "fs/promises";
import path from "path";
import os from "os";
import { existsSync } from "fs";
import { execFileSync } from "child_process";
import { compilePack, extractPack } from "@foundryvtt/foundryvtt-cli";

const manifest = JSON.parse(await fs.readFile("module.json", "utf8"));
const moduleID = manifest.id;
const badID = moduleID.replace("pf2e", "sf2e");
const pfPacks = manifest.packs
    .filter(pack => pack.system === "pf2e")
    .map(pack => ({ name: pack.name, path: pack.path }));
let sfPacks = manifest.packs
    .filter(pack => pack.system === "sf2e")
    .map(pack => ({ name: pack.name, path: pack.path }));

async function getChangedPfItems() {
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

function toCrLf(text) {
    const normalized = text.replace(/\r\n|\n/g, "\r\n");
    return normalized.endsWith("\r\n") ? normalized : `${normalized}\r\n`;
}

function replaceCompendiumLinks(text) {
    let updated = text;
    for (const pack of pfPacks) {
        updated = updated.replaceAll(
            `Compendium.${moduleID}.${pack.name}.`,
            `Compendium.${moduleID}.sf-${pack.name}.`
        );
    }

    return updated.replace(
        /Compendium\.pf2e\.([A-Za-z0-9_-]+)\.(Item\.)?([A-Za-z0-9]+)/g,
        (_match, pack, itemPrefix = "", itemId) => {
            if (pack === "conditionitems") {
                return `Compendium.sf2e.conditions.${itemPrefix}${itemId}`;
            }

            const anachronismPack = pack
                .replace(/-srd$/, "")
                .replace(/^actionspf2e$/, "actions")
                .replace(/^classfeatures$/, "class-features");
            return `Compendium.pf2e-anachronism.${anachronismPack}.${itemPrefix}${itemId}`;
        }
    );
}

async function fixLinksInFile(filePath) {
    const content = await fs.readFile(filePath, "utf8");
    const updated = toCrLf(replaceCompendiumLinks(content));
    if (content !== updated) await fs.writeFile(filePath, updated);
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

const changedPfItems = await getChangedPfItems();
const toBeAdded = pfPacks.filter(
    pfPack => !sfPacks.some(sfPack => sfPack.name.replace(/^sf-/, "") === pfPack.name)
);

for (const pfPack of toBeAdded) {
    const oldData = manifest.packs.find(pack => pack.name === pfPack.name);
    if (!oldData) throw new Error(`Missing manifest entry for PF2e pack ${pfPack.name}`);

    const newData = structuredClone(oldData);
    newData.name = `sf-${oldData.name}`;
    newData.path = oldData.path.replace("packs/", "packs/sf-");
    newData.system = "sf2e";
    manifest.packs.push(newData);
}

if (toBeAdded.length > 0) {
    await fs.writeFile("module.json", toCrLf(JSON.stringify(manifest, null, 4)));
    sfPacks = manifest.packs
        .filter(pack => pack.system === "sf2e")
        .map(pack => ({ name: pack.name, path: pack.path }));
}

const outDir = path.resolve(process.cwd(), "build");
const packsCompiled = path.resolve(outDir, "packs");
if (!existsSync(packsCompiled)) {
    throw new Error(`Packs directory does not exist in the build: ${packsCompiled}`);
}

for (const pfPack of pfPacks) {
    const sfPack = sfPacks.find(entry => entry.name.replace(/^sf-/, "") === pfPack.name);
    if (!sfPack) {
        console.warn(`Skipping ${pfPack.name}; no matching SF2e pack exists.`);
        continue;
    }

    const targetPackPath = path.resolve(sfPack.path);
    await fs.mkdir(targetPackPath, { recursive: true });
    const sourcePackItems = await getPackItems(path.resolve(pfPack.path));
    const targetItems = await getPackItems(targetPackPath);
    const itemsToSync = new Set(changedPfItems.get(pfPack.name));
    for (const itemId of sourcePackItems.keys()) {
        if (!targetItems.has(itemId)) itemsToSync.add(itemId);
    }
    if (itemsToSync.size === 0) continue;

    const tempPackRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pf2e-ac-pack-"));
    try {
        const extractedPackPath = path.join(tempPackRoot, pfPack.name);
        const compiledPackPath = path.resolve(packsCompiled, path.basename(pfPack.path));
        await extractPack(compiledPackPath, extractedPackPath);
        const sourceItems = await getPackItems(extractedPackPath);

        let updatedItems = 0;
        for (const itemId of itemsToSync) {
            const sourceFile = sourceItems.get(itemId);
            const targetFile = targetItems.get(itemId);
            if (sourceFile) {
                const sourceFilePath = path.resolve(extractedPackPath, sourceFile);
                const targetFilePath = path.resolve(targetPackPath, sourceFile);
                if (targetFile && targetFile !== sourceFile) {
                    await fs.rm(path.resolve(targetPackPath, targetFile));
                }

                await fs.copyFile(sourceFilePath, targetFilePath);
                await sendToSpace(targetPackPath, sourceFile);
                await fixLinksInFile(targetFilePath);
                updatedItems += 1;
            } else if (targetFile) {
                await fs.rm(path.resolve(targetPackPath, targetFile));
                updatedItems += 1;
                console.info(`Removed deleted PF2e item ${itemId} from ${targetPackPath}`);
            }
        }

        if (updatedItems === 0) continue;

        console.info(`Updated ${updatedItems} changed item(s) in ${targetPackPath}`);
        const compiledSfPackPath = path.resolve(outDir, sfPack.path);
        await fs.rm(compiledSfPackPath, { recursive: true, force: true });
        await compilePack(targetPackPath, compiledSfPackPath);
    } finally {
        await fs.rm(tempPackRoot, { recursive: true, force: true });
    }
}

async function sendToSpace(packPath, file) {
    const filePath = path.resolve(packPath, file);
    const fileData = JSON.parse(await fs.readFile(filePath, "utf8"));
    let serialized = replaceCompendiumLinks(JSON.stringify(fileData, null, 2));
    const links = [];
    serialized = serialized.replace(
        /Compendium\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.(?:Item\.)?[A-Za-z0-9]+/g,
        link => {
            links.push(link);
            return `__COMPENDIUM_LINK_${links.length - 1}__`;
        }
    );
    serialized = toCrLf(serialized
        .replaceAll("pf2e", "sf2e")
        .replaceAll("-srd", "")
        .replaceAll("classfeatures", "class-features")
        .replaceAll("conditionitems", "conditions")
        .replaceAll(badID, moduleID)
        .replaceAll("sf2e-macros", "macros")
        .replaceAll("actionssf2e", "actions"))
        .replace(/__COMPENDIUM_LINK_(\d+)__/g, (_match, index) => links[Number(index)]);
    await fs.writeFile(filePath, serialized);
}
