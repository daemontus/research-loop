import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { grepFiles } from "../agent/lib/grep.mjs";
import { MAX_TOOL_OUTPUT, makeTools, runBash, truncateMiddle } from "../agent/lib/tools.mjs";

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "file-tools-"));
  const sandbox = path.join(tmp, "sandbox");
  const researcherSandbox = path.join(tmp, "researcher-sandbox");
  fs.mkdirSync(path.join(sandbox, "src"), { recursive: true });
  fs.mkdirSync(path.join(researcherSandbox, "lib"), { recursive: true });
  const tools = makeTools(sandbox, {
    configDir: null,
    prefetchPath: path.join(tmp, "prefetch"),
    extraRoots: [{ prefix: "/researcher-sandbox", dir: researcherSandbox }],
    supportsImage: false,
  });
  const run = async (name, params) => {
    const tool = tools.find((t) => t.name === name);
    const res = await tool.execute("id", params);
    return res.content[0].text;
  };
  return { tmp, sandbox, researcherSandbox, run };
}

const numbered = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

test("read_file numbers lines and reads a whole small file without a footer", async () => {
  const { sandbox, run } = setup();
  fs.writeFileSync(path.join(sandbox, "a.txt"), "alpha\nbeta\n");
  assert.equal(await run("read_file", { path: "a.txt" }), "1\talpha\n2\tbeta");
});

test("read_file reads a line range and says how to continue", async () => {
  const { sandbox, run } = setup();
  fs.writeFileSync(path.join(sandbox, "big.txt"), numbered(50));
  const out = await run("read_file", { path: "big.txt", offset: 10, limit: 3 });
  assert.equal(out, "10\tline 10\n11\tline 11\n12\tline 12\n[lines 10-12 of 50; continue with offset=13]");
  const tail = await run("read_file", { path: "big.txt", offset: 49 });
  assert.equal(tail, "49\tline 49\n50\tline 50\n[lines 49-50 of 50]");
  assert.match(await run("read_file", { path: "big.txt", offset: 99 }), /has 50 lines; offset 99 is past the end/);
});

test("read_file never truncates silently when the output budget runs out", async () => {
  const { sandbox, run } = setup();
  const line = "x".repeat(1000);
  fs.writeFileSync(path.join(sandbox, "wide.txt"), Array(200).fill(line).join("\n"));
  const out = await run("read_file", { path: "wide.txt" });
  assert.ok(out.length <= MAX_TOOL_OUTPUT + 200);
  const footer = out.split("\n").at(-1);
  const m = footer.match(/^\[lines 1-(\d+) of 200; continue with offset=(\d+)\]$/);
  assert.ok(m, `unexpected footer: ${footer}`);
  assert.equal(Number(m[2]), Number(m[1]) + 1);
});

test("read_file shortens very long lines and refuses binary files", async () => {
  const { sandbox, run } = setup();
  fs.writeFileSync(path.join(sandbox, "min.js"), "y".repeat(5000));
  assert.match(await run("read_file", { path: "min.js" }), /… \[line truncated; 5000 chars\]$/);
  fs.writeFileSync(path.join(sandbox, "blob.bin"), Buffer.from([1, 2, 0, 3]));
  assert.match(await run("read_file", { path: "blob.bin" }), /^\[binary file/);
});

test("edit_file reports the line it edited", async () => {
  const { sandbox, run } = setup();
  fs.writeFileSync(path.join(sandbox, "f.rs"), "fn a() {}\nfn b() {}\nfn c() {}\n");
  assert.equal(await run("edit_file", { path: "f.rs", oldString: "fn b() {}", newString: "fn bb() {}" }), "edited f.rs (1 replacement at line 2)");
  assert.equal(fs.readFileSync(path.join(sandbox, "f.rs"), "utf8"), "fn a() {}\nfn bb() {}\nfn c() {}\n");
});

test("edit_file lists the lines of an ambiguous match", async () => {
  const { sandbox, run } = setup();
  fs.writeFileSync(path.join(sandbox, "f.py"), "x = 1\ny = 2\nx = 1\n");
  await assert.rejects(
    run("edit_file", { path: "f.py", oldString: "x = 1", newString: "x = 3" }),
    /appears 2 times in f\.py \(at lines 1, 3\)/,
  );
  assert.equal(
    await run("edit_file", { path: "f.py", oldString: "x = 1", newString: "x = 3", replaceAll: true }),
    "edited f.py (2 replacements at lines 1, 3)",
  );
});

test("edit_file points at a match that differs only in indentation", async () => {
  const { sandbox, run } = setup();
  fs.writeFileSync(path.join(sandbox, "g.py"), "def f():\n    if x:\n        return 1\n");
  await assert.rejects(
    run("edit_file", { path: "g.py", oldString: "  if x:\n    return 1", newString: "" }),
    /matches lines 2-3 if whitespace\/indentation is ignored/,
  );
});

test("edit_file points at where the first line occurs when a later line differs", async () => {
  const { sandbox, run } = setup();
  fs.writeFileSync(path.join(sandbox, "h.txt"), "start\nmiddle\nend\n");
  await assert.rejects(
    run("edit_file", { path: "h.txt", oldString: "middle\nfinish", newString: "" }),
    /first line \("middle"\) appears at line 2; a later line differs/,
  );
  await assert.rejects(
    run("edit_file", { path: "h.txt", oldString: "nowhere", newString: "" }),
    /appears nowhere in the file/,
  );
  await assert.rejects(run("edit_file", { path: "h.txt", oldString: "", newString: "x" }), /must not be empty/);
});

for (const forceFallback of [false, true]) {
  const label = forceFallback ? "built-in fallback" : "default backend";
  test(`grep (${label}) lists path:line:text and honours glob/ignoreCase`, async () => {
    const { sandbox } = setup();
    fs.writeFileSync(path.join(sandbox, "src", "main.rs"), "fn main() {\n    Solve();\n}\n");
    fs.writeFileSync(path.join(sandbox, "src", "notes.md"), "call solve() later\n");
    const out = await grepFiles(sandbox, ".", { pattern: "solve\\(", ignoreCase: true, forceFallback });
    assert.deepEqual(out.split("\n").sort(), ["./src/main.rs:2:    Solve();", "./src/notes.md:1:call solve() later"]);
    const rs = await grepFiles(path.join(sandbox, "src"), "src", { pattern: "solve", ignoreCase: true, glob: "*.rs", forceFallback });
    assert.equal(rs, "src/main.rs:2:    Solve();");
    const literal = await grepFiles(sandbox, ".", { pattern: "solve()", fixedStrings: true, forceFallback });
    assert.equal(literal, "./src/notes.md:1:call solve() later");
    assert.match(await grepFiles(sandbox, ".", { pattern: "absent", forceFallback }), /^no matches for "absent" in \.$/);
  });

  test(`grep (${label}) caps results and says so`, async () => {
    const { sandbox } = setup();
    fs.writeFileSync(path.join(sandbox, "many.txt"), numbered(30));
    const out = await grepFiles(sandbox, ".", { pattern: "line", maxResults: 5, forceFallback });
    const lines = out.split("\n");
    assert.equal(lines.length, 6);
    assert.equal(lines[0], "./many.txt:1:line 1");
    assert.match(lines[5], /showing the first 5 matches/);
  });
}

test("grep tool searches a read-only root and a single file", async () => {
  const { researcherSandbox, run } = setup();
  fs.writeFileSync(path.join(researcherSandbox, "lib", "x.py"), "import os\nTODO = 1\n");
  assert.equal(await run("grep", { pattern: "TODO", path: "/researcher-sandbox" }), "/researcher-sandbox/lib/x.py:2:TODO = 1");
  assert.equal(await run("grep", { pattern: "import", path: "/researcher-sandbox/lib/x.py" }), "/researcher-sandbox/lib/x.py:1:import os");
  await assert.rejects(run("grep", { pattern: "x", path: "../outside" }), /escapes sandbox/);
});

test("truncateMiddle keeps the start and the end of long output", () => {
  assert.equal(truncateMiddle("short", 100), "short");
  const text = `BEGIN${"m".repeat(1000)}END-ERROR`;
  const out = truncateMiddle(text, 100);
  assert.ok(out.startsWith("BEGIN"));
  assert.ok(out.endsWith("END-ERROR"));
  assert.match(out, /\[\.\.\. \d+ characters omitted \.\.\.\]/);
});

test("bash output keeps the tail (where errors are) when it is too long", async () => {
  const { sandbox } = setup();
  const out = await runBash(sandbox, `head -c 100000 /dev/zero | tr '\\0' 'a'; echo; echo FINAL-ERROR; exit 3`);
  assert.match(out, /^command failed/);
  assert.match(out, /characters omitted/);
  assert.match(out, /FINAL-ERROR\s*$/);
  assert.ok(out.length <= MAX_TOOL_OUTPUT + 100);
});
