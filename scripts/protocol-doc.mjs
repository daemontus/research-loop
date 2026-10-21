#!/usr/bin/env node
/** Regenerate the transition table in docs/PROTOCOL.md from the state machine. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderTransitionTable } from "../control-plane/state-machine.mjs";

const doc = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "PROTOCOL.md");
const text = fs.readFileSync(doc, "utf8");
const begin = "<!-- BEGIN GENERATED TRANSITIONS -->";
const end = "<!-- END GENERATED TRANSITIONS -->";
const updated = text.replace(new RegExp(`${begin}[\\s\\S]*?${end}`), `${begin}\n${renderTransitionTable()}\n${end}`);
fs.writeFileSync(doc, updated);
console.log(updated === text ? "docs/PROTOCOL.md is up to date" : "updated docs/PROTOCOL.md");
