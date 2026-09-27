#!/usr/bin/env node
// Demo dashboard for the finance agent (Ledger): recorded before/after runs and live runs
// with the guards on or off.  Run:  node demo/server.mjs   then open http://localhost:4747
//
// "Guards off" renames every *policies.mjs file to *.off for one run (only files ending in
// policies.mjs load) and always renames them back — in `finally`, on Ctrl-C, and at startup.
// Live runs are practice tasks only: final-round sessions are scored, so they are view-only here.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const AGENT_DIR = join(REPO, "agents", "finance-agent");
const POLICY_DIR = join(AGENT_DIR, ".failproofai", "policies");
const TRANSCRIPTS = join(AGENT_DIR, ".runs", "transcripts");
const MANIFEST = join(HERE, "runs.json"); // { "<transcript file>": "on" | "off" }
const CLAUDE_DIR = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects", AGENT_DIR.replace(/[^A-Za-z0-9]/g, "-"));
const PORT = Number(process.env.PORT || 4747);

const TASKS = JSON.parse(readFileSync(join(AGENT_DIR, "tasks.json"), "utf8")).tasks;

// ---- guards on/off ---------------------------------------------------------------------

const policyFiles = (suffix) => (existsSync(POLICY_DIR) ? readdirSync(POLICY_DIR).filter((f) => f.endsWith(suffix)) : []);
function guardsOff() {
  for (const f of policyFiles("policies.mjs")) renameSync(join(POLICY_DIR, f), join(POLICY_DIR, f + ".off"));
}
function restoreGuards() {
  for (const f of policyFiles("policies.mjs.off")) {
    const on = join(POLICY_DIR, f.slice(0, -4));
    if (!existsSync(on)) renameSync(join(POLICY_DIR, f), on);
  }
}
const guardsOn = () => policyFiles("policies.mjs").length > 0;
restoreGuards();
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => (restoreGuards(), process.exit(0)));
process.on("exit", restoreGuards);

// Other `buildathon run` processes would silently run unguarded while we toggle.
function otherRunsActive() {
  const r = spawnSync("pgrep", ["-f", "buildathon.mjs run"], { encoding: "utf8" });
  return r.stdout.trim().split("\n").filter(Boolean).length > 0;
}

// ---- transcripts -> steps ----------------------------------------------------------------

const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (typeof x === "string" ? x : x?.text ?? "")).join("\n") : c ? JSON.stringify(c) : "");
const REASON = /because: ([\s\S]*?)(?:, as per the policy configured by the user)?$/;

/** Claude transcript or stream-json lines -> [{kind:"call"|"text", ...}] in order. */
function parseSteps(raw) {
  const steps = [];
  const byId = new Map();
  for (const line of raw.split("\n")) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    const content = Array.isArray(m.message?.content) ? m.message.content : [];
    for (const b of content) {
      if (b.type === "text" && m.message.role === "assistant" && b.text?.trim()) steps.push({ kind: "text", text: b.text.trim() });
      if (b.type === "tool_use") {
        const s = { kind: "call", tool: String(b.name).replace(/^mcp__[^_]+__/, ""), args: b.input ?? {}, status: "pending" };
        byId.set(b.id, s);
        steps.push(s);
      }
      if (b.type === "tool_result" && byId.has(b.tool_use_id)) {
        const s = byId.get(b.tool_use_id);
        const t = textOf(b.content);
        if (!/"_env":/.test(t) && /hook error|because:/i.test(t)) {
          s.status = "blocked";
          s.reason = (REASON.exec(t.trim())?.[1] ?? t).trim();
        } else {
          s.status = b.is_error ? "error" : "ok";
          try {
            const j = JSON.parse(t);
            delete j._env;
            s.result = j;
          } catch {
            s.result = t.slice(0, 600);
          }
        }
      }
    }
  }
  return steps;
}

const manifest = () => (existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : {});
function remember(file, mode) {
  const m = manifest();
  m[file] = mode;
  writeFileSync(MANIFEST, JSON.stringify(m, null, 2));
}

function listRuns() {
  if (!existsSync(TRANSCRIPTS)) return [];
  const m = manifest();
  return readdirSync(TRANSCRIPTS)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const task = f.split("-claude-")[0].split("-codex-")[0];
      return { file: f, task, at: statSync(join(TRANSCRIPTS, f)).mtimeMs, guards: m[f] ?? "on" };
    })
    .sort((a, b) => b.at - a.at);
}

// ---- live run ------------------------------------------------------------------------------

let busy = false;

async function liveRun(taskId, guards, send) {
  const started = Date.now();
  if (guards === "off") guardsOff();
  try {
    send({ type: "start", task: taskId, guards });
    const child = spawn("node", [join(REPO, "bin", "buildathon.mjs"), "run", "finance", taskId], { cwd: REPO, env: { ...process.env, FORCE_COLOR: "0" } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));

    // Stream steps from the harness's own session file while the agent works.
    let sent = 0;
    const poll = setInterval(() => {
      if (!existsSync(CLAUDE_DIR)) return;
      const f = readdirSync(CLAUDE_DIR)
        .filter((x) => x.endsWith(".jsonl"))
        .map((x) => ({ x, t: statSync(join(CLAUDE_DIR, x)).birthtimeMs }))
        .filter((x) => x.t >= started - 2000)
        .sort((a, b) => b.t - a.t)[0];
      if (!f) return;
      const steps = parseSteps(readFileSync(join(CLAUDE_DIR, f.x), "utf8"));
      send({ type: "steps", steps });
      sent = steps.length;
    }, 800);

    const code = await new Promise((r) => child.on("close", r));
    clearInterval(poll);
    const file = /transcript (\S+\.jsonl)/.exec(out.replace(/\x1b\[[0-9;]*m/g, ""))?.[1];
    if (file && existsSync(file)) {
      const name = file.split("/").pop();
      remember(name, guards);
      send({ type: "steps", steps: parseSteps(readFileSync(file, "utf8")) });
      send({ type: "done", code, file: name });
    } else {
      send({ type: "done", code, error: sent ? null : out.slice(-800) });
    }
  } finally {
    restoreGuards();
  }
}

// ---- http -------------------------------------------------------------------------------------

const json = (res, body, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(readFileSync(join(HERE, "index.html")));
    }
    if (url.pathname === "/meme.png") {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(readFileSync(join(HERE, "meme.png")));
    }
    if (url.pathname === "/api/state") return json(res, { tasks: TASKS, runs: listRuns(), guards: guardsOn(), policies: policyFiles("policies.mjs"), busy });
    if (url.pathname === "/api/run") {
      const f = url.searchParams.get("file") ?? "";
      if (!/^[\w.-]+\.jsonl$/.test(f) || !existsSync(join(TRANSCRIPTS, f))) return json(res, { error: "no such run" }, 404);
      return json(res, { steps: parseSteps(readFileSync(join(TRANSCRIPTS, f), "utf8")) });
    }
    if (url.pathname === "/api/live" && req.method === "POST") {
      const task = url.searchParams.get("task");
      const guards = url.searchParams.get("guards") === "off" ? "off" : "on";
      if (!TASKS.some((t) => t.id === task)) return json(res, { error: "unknown practice task" }, 400);
      if (busy) return json(res, { error: "a live run is already in progress" }, 409);
      if (!guardsOn()) return json(res, { error: "no policy files are installed for the finance agent" }, 409);
      if (guards === "off" && otherRunsActive()) return json(res, { error: "another buildathon run is in progress; wait for it before a guards-off run so it isn't left unguarded" }, 409);
      busy = true;
      res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
      try {
        await liveRun(task, guards, (e) => res.write(JSON.stringify(e) + "\n"));
      } finally {
        busy = false;
        res.end();
      }
      return;
    }
    json(res, { error: "not found" }, 404);
  } catch (e) {
    if (!res.headersSent) json(res, { error: String(e.message ?? e) }, 500);
    else res.end();
  }
}).listen(PORT, "127.0.0.1", () => console.log(`Ledger demo → http://localhost:${PORT}   (guards ${guardsOn() ? "ON" : "MISSING"})`));
