import fs from "fs/promises";
import path from "path";
import { existsSync } from "fs";
import { extractPack } from "@foundryvtt/foundryvtt-cli";

console.log("Reading manifest")
// Read from manifest
const manifest = await fs.readFile("module.json")
const data = JSON.parse(manifest)
const moduleID = data.id
const badID = moduleID.replace("pf2e", "sf2e")

// Find all PF and existing SF packs
const pfPacks = data.packs.filter(p => p.system === "pf2e").map(p => ({ name: p.name, path: p.path }))
const sfPacks = data.packs.filter(p => p.system === "sf2e").map(p => ({ name: p.name, path: p.path }))

// Ordered list of replacement pack prefixes to try for broken UUID links
const LINK_REPLACEMENTS = [
    ["pf2e.", "sf2e."]
];

function toCrLf(text) {
    const normalized = text.replace(/\r\n|\n/g, "\r\n");
    return normalized.endsWith("\r\n") ? normalized : `${normalized}\r\n`;
}

async function normalizeJsonFiles(targetDir) {
    if (!existsSync(targetDir)) return;

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

function replaceCompendiumLinks(str) {
    let replaced = false;
    for (const [from, to] of LINK_REPLACEMENTS) {
        const fromPattern = `Compendium.${from}`;
        const toPattern = `Compendium.${to}`;
        if (str.includes(fromPattern)) {
            str = str.replaceAll(fromPattern, toPattern);
            replaced = true;
        }
    }
    return { str, replaced };
}

async function fixLinksInPack(packPath) {
    const files = await fs.readdir(packPath, { withFileTypes: true });
    for (const file of files) {
        if (!file.isFile() || !file.name.toLowerCase().endsWith('.json')) continue;
        const filePath = path.resolve(packPath, file.name);
        let content = await fs.readFile(filePath, 'utf8');
        const result = replaceCompendiumLinks(content);
        const normalizedContent = toCrLf(result.str);
        if (result.replaced || content !== normalizedContent) {
            await fs.writeFile(filePath, normalizedContent);
            console.log(`Fixed compendium links in ${filePath}`);
        }
    }
}

// We need to make sure packs with pf2e in the name don't break things
const badPacks = data.packs.filter(p => p.system === "pf2e").map(n => n.name.replace("pf2e", "sf2e"))

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
    console.error("Packs directory does not exist in the build");
}

const packFolders = await fs.readdir(packsCompiled);

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
    await extractPack(path.resolve(packsCompiled, pack), `packs/${pack}`);
}

console.log("Rebuilding SF packs from PF packs")
for (const pfPack of pfPacks) {
    const sourcePackPath = path.resolve(pfPack.path);
    const sfPackEntry = sfPacks.find(sf => sf.name.replace("sf-", "") === pfPack.name);
    if (!sfPackEntry) {
        console.log(`Skipping ${pfPack.name}; no corresponding sf- pack defined in module.json.`);
        continue;
    }
    const targetPackPath = path.resolve(sfPackEntry.path);

    await fs.rm(targetPackPath, { recursive: true, force: true });
    await fs.mkdir(targetPackPath, { recursive: true });

    const sourceFiles = await fs.readdir(sourcePackPath, { withFileTypes: true });
    const sourceJsonFiles = sourceFiles
        .filter((f) => f.isFile() && f.name.toLowerCase().endsWith(".json"))
        .map((f) => f.name);

    console.log(`Rebuilding ${sourceJsonFiles.length} item(s) in ${targetPackPath}`);
    for (const file of sourceJsonFiles) {
        const sourceFilePath = path.resolve(sourcePackPath, file);
        const targetFilePath = path.resolve(targetPackPath, file);
        await fs.copyFile(sourceFilePath, targetFilePath);
        await sendToSpace(targetPackPath, file);
    }

    await fixLinksInPack(targetPackPath);
}

await normalizeJsonFiles(path.resolve(process.cwd(), "packs"));
await normalizeJsonFiles(path.resolve(process.cwd(), "build", "packs"));

console.log("Starfinder conversion completed!")
console.log("Remember to add compendium folder entries for your new Starfinder compendiums and add Starfinder to the supported systems.")
console.log("Any links to Pathfinder exclusive items will need to be fixed manually to redirect to Anachronism.")

function rewriteCompendiumPrefixes(str) {
    let updated = str;

    for (const pack of pfPacks) {
        const oldPrefix = `Compendium.${moduleID}.${pack.name}.`;
        const newPrefix = `Compendium.${moduleID}.sf-${pack.name}.`;
        if (updated.includes(oldPrefix)) {
            updated = updated.replaceAll(oldPrefix, newPrefix);
        }
    }

    return updated;
}

async function sendToSpace(packPath, file) {
    const fileData = await fs.readFile(path.resolve(packPath, file))
    let newFileData = toCrLf(JSON.stringify(JSON.parse(fileData), null, 2)
        .replaceAll("pf2e", "sf2e")
        .replaceAll("-srd", "")
        .replaceAll("classfeatures", "class-features")
        .replaceAll("conditionitems", "conditions")
        .replaceAll(badID, moduleID)
        .replaceAll("sf2e-macros", "macros")
        .replaceAll("actionssf2e", "actions"))

    newFileData = rewriteCompendiumPrefixes(newFileData)

    await fs.writeFile(path.resolve(packPath, file), newFileData)
}