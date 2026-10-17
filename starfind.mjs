import fs from "fs/promises";
import path from "path";
import os from "os";
import { existsSync } from "fs";
import { execFileSync } from "child_process";
import { compilePack, extractPack } from "@foundryvtt/foundryvtt-cli";

console.log("Reading manifest")
// Read from manifest
const manifest = await fs.readFile("module.json")
const data = JSON.parse(manifest)
const moduleID = data.id
const badID = moduleID.replace("pf2e", "sf2e")

// Find all PF and existing SF packs
const pfPacks = data.packs.filter(p => p.system === "pf2e").map(p => ({ name: p.name, path: p.path }))
const sfPacks = data.packs.filter(p => p.system === "sf2e").map(p => ({ name: p.name, path: p.path }))

async function getChangedPfItems() {
    const packPaths = pfPacks.map(pack => `${pack.path.replaceAll("\\", "/")}/`);
    let changedPaths;

    try {
        const diffPaths = execFileSync("git", [
            "diff", "--name-only", "--no-renames", "HEAD", "--", ...packPaths
        ], { encoding: "utf8" });
        const untrackedPaths = execFileSync("git", [
            "ls-files", "--others", "--exclude-standard", "--", ...packPaths
        ], { encoding: "utf8" });
        changedPaths = [...diffPaths.split(/\r?\n/), ...untrackedPaths.split(/\r?\n/)]
            .filter(Boolean);
    } catch (error) {
        if (error.code !== "ENOENT" && error.status !== 128) throw error;
        console.warn(`Unable to detect changed PF2e items from Git; leaving SF2e packs unchanged: ${error.message}`);
        return new Map();
    }

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

const changedPfItems = await getChangedPfItems();

function toCrLf(text) {
    const normalized = text.replace(/\r\n|\n/g, "\r\n");
    return normalized.endsWith("\r\n") ? normalized : `${normalized}\r\n`;
}

function replaceCompendiumLinks(str) {
    let updated = str;

    for (const pack of pfPacks) {
        const oldPrefix = `Compendium.${moduleID}.${pack.name}.`;
        const newPrefix = `Compendium.${moduleID}.sf-${pack.name}.`;
        updated = updated.replaceAll(oldPrefix, newPrefix);
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
    let content = await fs.readFile(filePath, 'utf8');
    const rewrittenContent = replaceCompendiumLinks(content);
    const normalizedContent = toCrLf(rewrittenContent);
    if (content !== normalizedContent) {
        await fs.writeFile(filePath, normalizedContent);
        console.log(`Fixed compendium links in ${filePath}`);
    }
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

// We don't want to add existing SF packs again!
const toBeAdded = pfPacks.filter(pf => !sfPacks.some(sf => sf.name.replace("sf-", "") === pf.name))

if (toBeAdded.length > 0) console.log("Modifying manifest");
// Make the new pack object
for (const addedPack of toBeAdded) {
    const oldData = data.packs.find(p => p.name === addedPack);
    const newName = "sf-" + oldData.name;
    const newPath = oldData.path.replace("packs/", "packs/sf-");
    const newData = structuredClone(oldData);
    newData.name = newName;
    newData.path = newPath;
    newData.system = "sf2e";
    data.packs.push(newData)
}

// Write the new data to the manifest
await fs.writeFile("module.json", toCrLf(JSON.stringify(data, null, 4)))

console.log("Checking for extracted data structure")
// Make a pack folder for each pack if they don't exist
for (const pack of data.packs) {
    const packPath = path.resolve(pack.path);
    if (!existsSync(packPath)) {
        await fs.mkdir(packPath, {recursive: true})
    }
}

const outDir = path.resolve(process.cwd(), "build");
const packsCompiled = path.resolve(outDir, "packs/");
if (!existsSync(packsCompiled)) {
    throw new Error(`Packs directory does not exist in the build: ${packsCompiled}`);
}

console.log("Extracting changed PF items and updating their SF equivalents")
for (const pfPack of pfPacks) {
    const changedItems = changedPfItems.get(pfPack.name);
    if (changedItems.size === 0) continue;

    const sfPackEntry = sfPacks.find(sf => sf.name.replace("sf-", "") === pfPack.name);
    if (!sfPackEntry) {
        console.log(`Skipping changed items in ${pfPack.name}; no corresponding sf- pack defined in module.json.`);
        continue;
    }
    const targetPackPath = path.resolve(sfPackEntry.path);
    await fs.mkdir(targetPackPath, { recursive: true });

    const tempPackRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pf2e-ac-pack-"));
    try {
        const extractedPackPath = path.join(tempPackRoot, pfPack.name);
        const compiledPackPath = path.resolve(packsCompiled, path.basename(pfPack.path));
        await extractPack(compiledPackPath, extractedPackPath);
        const sourceItems = await getPackItems(extractedPackPath);
        const targetItems = await getPackItems(targetPackPath);

        let updatedItems = 0;
        for (const itemId of changedItems) {
            const sourceFile = sourceItems.get(itemId);
            const targetFile = targetItems.get(itemId);
            if (sourceFile) {
                const sourceFilePath = path.resolve(extractedPackPath, sourceFile);
                const targetFilePath = path.resolve(targetPackPath, sourceFile);
                if (targetFile && targetFile !== sourceFile) {
                    await fs.rm(path.resolve(targetPackPath, targetFile));
                }
                await fs.mkdir(path.dirname(targetFilePath), { recursive: true });
                await fs.copyFile(sourceFilePath, targetFilePath);
                await sendToSpace(targetPackPath, sourceFile);
                await fixLinksInFile(targetFilePath);
                updatedItems += 1;
            } else if (targetFile) {
                await fs.rm(path.resolve(targetPackPath, targetFile));
                updatedItems += 1;
                console.log(`Removed deleted PF2e item ${path.resolve(targetPackPath, targetFile)}`);
            }
        }

        if (updatedItems === 0) continue;

        console.log(`Updated ${updatedItems} changed item(s) in ${targetPackPath}`);
        const compiledSfPackPath = path.resolve(outDir, sfPackEntry.path);
        await fs.rm(compiledSfPackPath, { recursive: true, force: true });
        await compilePack(targetPackPath, compiledSfPackPath);
    } finally {
        await fs.rm(tempPackRoot, { recursive: true, force: true });
    }
}

console.log("Starfinder conversion completed!")
console.log("Remember to add compendium folder entries for your new Starfinder compendiums and add Starfinder to the supported systems.")
console.log("Any links to Pathfinder exclusive items will need to be fixed manually to redirect to Anachronism.")

async function sendToSpace(packPath, file) {
    const fileData = await fs.readFile(path.resolve(packPath, file))
    let newFileData = replaceCompendiumLinks(JSON.stringify(JSON.parse(fileData), null, 2));
    const compendiumLinks = [];
    newFileData = newFileData.replace(
        /Compendium\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.(?:Item\.)?[A-Za-z0-9]+/g,
        link => {
            compendiumLinks.push(link);
            return `__COMPENDIUM_LINK_${compendiumLinks.length - 1}__`;
        }
    );
    newFileData = toCrLf(newFileData
        .replaceAll("pf2e", "sf2e")
        .replaceAll("-srd", "")
        .replaceAll("classfeatures", "class-features")
        .replaceAll("conditionitems", "conditions")
        .replaceAll(badID, moduleID)
        .replaceAll("sf2e-macros", "macros")
        .replaceAll("actionssf2e", "actions"))
        .replace(/__COMPENDIUM_LINK_(\d+)__/g, (_match, index) => compendiumLinks[Number(index)]);

    await fs.writeFile(path.resolve(packPath, file), newFileData)
}