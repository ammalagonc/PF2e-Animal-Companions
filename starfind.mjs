import fs from "fs/promises";
import path from "path";
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

// Ordered list of replacement pack prefixes to try for broken UUID links
const LINK_REPLACEMENTS = [
    ["pf2e.", "sf2e."]
];

const SF2E_CONDITION_IDS = new Set([
    "XgEqL1kFApUbl5Z2",
    "i3OJZU2nk64Df3xm",
    "DmAIPqOBomZ7H95W",
    "yblD8fOR1J8rDwEQ",
    "TkIyaNPgTZFBCCuh",
    "9PR9y0bi4JPKnHPR",
    "MIRkyAjyBeXivMa7",
    "AdPVz7rbaVSRxHFg",
    "HL2l2VRSaQHu9lUw",
    "TBSHQspnbcqxsmjL",
    "kWc1fhmv9LBiTuei",
    "iU0fEDdBp3rXpTMC",
    "eIcWbB5o3pP6OIMe",
    "zJxUflt9np0q4yML",
    "AJh5ex99aV6VTggg",
    "6uEgoh53GbXuHpTF",
    "j91X7x0XSomq8d60",
    "VcDeM8A5oI6VqhbM",
    "fesd1n5eVhpCSS18",
    "xYTAsEpcJE1Ccni3",
    "dfCMdR4wnpbYNTix",
    "e1XGnhKNSQIm5IXg",
    "fBnFDH2MTzgFijKf",
    "VRSef5y1LmL2Hkjf",
    "4D2KBtexWXa6oUMR"
]);

function toCrLf(text) {
    const normalized = text.replace(/\r\n|\n/g, "\r\n");
    return normalized.endsWith("\r\n") ? normalized : `${normalized}\r\n`;
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

async function fixLinksInFile(filePath) {
    let content = await fs.readFile(filePath, 'utf8');
    const result = replaceCompendiumLinks(content);
    const normalizedContent = toCrLf(result.str);
    if (result.replaced || content !== normalizedContent) {
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

console.log("Updating SF packs from changed PF items")
for (const pfPack of pfPacks) {
    const changedItems = changedPfItems.get(pfPack.name);
    if (changedItems.size === 0) continue;

    const sourcePackPath = path.resolve(pfPack.path);
    const sfPackEntry = sfPacks.find(sf => sf.name.replace("sf-", "") === pfPack.name);
    if (!sfPackEntry) {
        console.log(`Skipping changed items in ${pfPack.name}; no corresponding sf- pack defined in module.json.`);
        continue;
    }
    const targetPackPath = path.resolve(sfPackEntry.path);
    await fs.mkdir(targetPackPath, { recursive: true });
    const sourceItems = await getPackItems(sourcePackPath);
    const targetItems = await getPackItems(targetPackPath);

    let updatedItems = 0;
    for (const itemId of changedItems) {
        const sourceFile = sourceItems.get(itemId);
        const targetFile = targetItems.get(itemId);
        if (sourceFile) {
            const sourceFilePath = path.resolve(sourcePackPath, sourceFile);
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
    const compiledPackPath = path.resolve(outDir, sfPackEntry.path);
    await fs.rm(compiledPackPath, { recursive: true, force: true });
    await compilePack(targetPackPath, compiledPackPath);
}

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

function rewriteConditionLinks(str) {
    return str.replaceAll(
        /Compendium\.sf2e\.conditions\.(Item\.)?([A-Za-z0-9]+)/g,
        (match, itemPrefix = "", conditionID) => SF2E_CONDITION_IDS.has(conditionID)
            ? match
            : `Compendium.pf2e-anachronism.conditions.${itemPrefix}${conditionID}`
    );
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

    newFileData = rewriteConditionLinks(newFileData)
    newFileData = rewriteCompendiumPrefixes(newFileData)

    await fs.writeFile(path.resolve(packPath, file), newFileData)
}