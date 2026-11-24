#!/usr/bin/env node
// quantisnow: the Quantisnow SEC API from a terminal, and an MCP bridge for
// AI clients. Docs: https://www.quantisnow.com/sec-api/cli

import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import {
  API,
  DATASETS,
  EIGHT_K_ITEMS,
  KEYS_URL,
  SITE,
  KEY_RE,
  MCP_CLIENTS,
  MCP_URL,
  bold,
  configPath,
  congressQuery,
  cyan,
  dim,
  eventsQuery,
  filingsQuery,
  financialsQuery,
  formatResults,
  holdersQuery,
  httpEntry,
  insidersQuery,
  intFlag,
  maskKey,
  mergeConfig,
  parseArgs,
  parseMcpBody,
  red,
  stdioEntry,
} from "../src/lib.mjs";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const UA = `quantisnow-cli/${VERSION} node/${process.versions.node}`;
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const CONFIG = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "quantisnow", "config.json");

// ---- Key ----

function readConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG, "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(next) {
  mkdirSync(dirname(CONFIG), { recursive: true });
  writeFileSync(CONFIG, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(CONFIG, 0o600);
  } catch {
    /* Windows */
  }
}

// Refreshes a browser sign-in that is about to expire. Returns the access token.
async function oauthToken(force = false) {
  const cfg = readConfig();
  const o = cfg.oauth;
  if (!o?.accessToken) return null;
  if (!force && o.expiresAt > Date.now() + 60_000) return o.accessToken;
  const res = await fetch(`${SITE}/api/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: o.refreshToken, client_id: o.clientId }),
  });
  if (!res.ok) return null;
  const t = await res.json();
  saveConfig({ ...cfg, oauth: { ...o, accessToken: t.access_token, refreshToken: t.refresh_token ?? o.refreshToken, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000 } });
  return t.access_token;
}

// The credential for this run: --key, QUANTISNOW_API_KEY, a saved key, or a
// saved browser sign-in.
async function credential(flags) {
  if (typeof flags.key === "string" && flags.key) return flags.key;
  if (process.env.QUANTISNOW_API_KEY) return process.env.QUANTISNOW_API_KEY;
  const cfg = readConfig();
  if (cfg.apiKey) return cfg.apiKey;
  return oauthToken();
}

function usingOAuth(flags) {
  return !(typeof flags.key === "string" && flags.key) && !process.env.QUANTISNOW_API_KEY && !readConfig().apiKey && Boolean(readConfig().oauth);
}

async function needKey(flags) {
  const key = await credential(flags);
  if (key) return key;
  fail(`Not signed in. Run ${bold("npx quantisnow login", tty)} (free, no card).`);
}

// ---- HTTP ----

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function call(key, path, body, method = "POST", retried = false) {
  const res = await fetch(`${API}/${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "user-agent": UA },
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (res.status === 401 && !retried && !KEY_RE.test(key)) {
    const fresh = await oauthToken(true);
    if (fresh) return call(fresh, path, body, method, true);
  }
  if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? "http_error", json?.error?.message ?? `HTTP ${res.status}`);
  const credits = res.headers.get("x-credits-remaining");
  const left = res.headers.get("x-ratelimit-remaining");
  return { json, left: left === null ? null : Number(left), credits: credits === null ? null : Number(credits) };
}

function fail(msg, code = 1) {
  process.stderr.write(`${red("Error:", process.stderr.isTTY)} ${msg}\n`);
  process.exit(code);
}

function print(out, flags) {
  if (flags.json) {
    process.stdout.write(JSON.stringify(out.json, null, 2) + "\n");
    return;
  }
  process.stdout.write(formatResults(out.json, { color: tty, links: !flags.noLinks }) + "\n");
  // Quiet unless the account is about to run out. A call paid from credits
  // carries x-credits-remaining; the plan's monthly count only matters without it.
  if (out.credits !== null) {
    if (out.credits <= 3) process.stderr.write(dim(`${out.credits} call${out.credits === 1 ? "" : "s"} left. More: ${KEYS_URL}\n`, process.stderr.isTTY));
  } else if (out.left !== null && out.left > 0 && out.left < 100) process.stderr.write(dim(`${out.left} calls left this month.\n`, process.stderr.isTTY));
}

async function run(flags, path, body) {
  const key = await needKey(flags);
  try {
    print(await call(key, path, body), flags);
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 401) fail(`${err.message}\nRun npx quantisnow login to sign in again.`);
      fail(err.message);
    }
    fail(`Couldn't reach ${API}: ${err.message}`);
  }
}

// ---- Commands ----

const HELP = `
${bold("quantisnow", tty)} ${dim(`v${VERSION}`, tty)}  SEC EDGAR data from your terminal and your AI tools

${bold("Start", tty)}
  npx quantisnow login                     Sign in in your browser (free, no card)
  npx quantisnow mcp install claude-code   Plug the SEC API into Claude Code (or cursor, claude-desktop, vscode, windsurf, codex, gemini)

${bold("Search", tty)}
  search "going concern" --forms 10-K       Words and phrases inside every SEC filing, exhibits included
  ask "insider buys over $1M this week"     Plain English, we write the query
  insiders NVDA                             Recent insider buys (--sells, --all, --min 1m, --days 90)
  filings TSLA --form 8-K                   A company's filings (--days 365)
  events officers                           8-K items: ${Object.keys(EIGHT_K_ITEMS).slice(0, 6).join(", ")}... or a number like 5.02
  holders AAPL                              Largest 13F holders last quarter (--change new|sold)
  financials MSFT                           Quarterly statements from XBRL (--annual)
  congress NVDA                             House members' trades (--min 50k)
  query <dataset> "<lucene>"                Any dataset, any query (see: quantisnow datasets)

${bold("Account", tty)}
  usage                                     Plan, calls left, credits (free, never counts as a call)
  whoami | logout

${bold("Options", tty)}
  -n, --size <n>     Results (default 10, max 50)
  -j, --json         Raw JSON, for piping into jq
  --key <qs_...>     Use this key (or set QUANTISNOW_API_KEY)
  --no-links         Hide links under each row

Docs: https://www.quantisnow.com/sec-api   Keys: ${KEYS_URL}
`;

function openUrl(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

function prompt(q) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) =>
    rl.question(q, (a) => {
      rl.close();
      resolve(a.trim());
    }),
  );
}

// Browser sign-in: OAuth 2.1 with PKCE and a one-off loopback redirect, the
// same flow MCP connectors use. --key (or --paste) saves an API key instead.
async function login(flags) {
  if (typeof flags.key === "string" || flags.paste) return loginWithKey(flags);
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
  const reg = await fetch(`${SITE}/api/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": UA },
    body: JSON.stringify({ client_name: "Quantisnow CLI", redirect_uris: [redirectUri], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!reg?.client_id) {
    server.close();
    fail("Couldn't start the sign-in. Try npx quantisnow login --paste to paste a key instead.");
  }
  const url = `${SITE}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: redirectUri, state, scope: "mcp", code_challenge: challenge, code_challenge_method: "S256", resource: MCP_URL })}`;
  const err = process.stderr.isTTY;
  process.stderr.write(`\nOpening your browser to sign in to Quantisnow.\nIf it doesn't open, go to:\n${cyan(url, err)}\n\n`);
  if (!flags.noBrowser) openUrl(url);
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 10 * 60_000);
    server.on("request", (req, res) => {
      const u = new URL(req.url, redirectUri);
      if (u.pathname !== "/callback") return void res.writeHead(404).end();
      const ok = u.searchParams.get("state") === state && u.searchParams.get("code");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><meta charset="utf-8"><title>Quantisnow CLI</title><body style="font:16px system-ui;padding:48px;max-width:520px;margin:auto">${ok ? "<h2>You're signed in.</h2><p>Go back to your terminal.</p>" : "<h2>Sign-in didn't finish.</h2><p>Run npx quantisnow login again.</p>"}</body>`);
      clearTimeout(timer);
      resolve(ok ? u.searchParams.get("code") : null);
    });
  });
  server.close();
  if (!code) fail("Sign-in was cancelled or timed out.");
  const t = await fetch(`${SITE}/api/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: reg.client_id, code_verifier: verifier, resource: MCP_URL }),
  }).then((r) => r.json()).catch(() => null);
  if (!t?.access_token) fail(`Sign-in failed${t?.error_description ? `: ${t.error_description}` : ""}.`);
  const cfg = readConfig();
  delete cfg.apiKey;
  saveConfig({ ...cfg, oauth: { clientId: reg.client_id, accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000 } });
  await welcome(t.access_token);
}

async function loginWithKey(flags) {
  let key = typeof flags.key === "string" ? flags.key : null;
  if (!key) {
    process.stderr.write(`\nMake a key at ${cyan(KEYS_URL, process.stderr.isTTY)} and paste it here.\n\n`);
    if (!flags.noBrowser) openUrl(KEYS_URL);
    key = await prompt("API key (qs_...): ");
  }
  if (!KEY_RE.test(key)) fail("That doesn't look like a Quantisnow key. Keys start with qs_ and have 40 more characters.");
  const cfg = readConfig();
  delete cfg.oauth;
  await welcome(key, () => saveConfig({ ...cfg, apiKey: key }));
}

async function welcome(token, save = () => {}) {
  try {
    const { json } = await call(token, "usage", null, "GET");
    save();
    const calls = json.callsPerMonth > 0 ? `${json.callsPerMonth.toLocaleString("en-US")} calls a month` : `${Number(json.credits ?? 0).toLocaleString("en-US")} free calls left`;
    process.stderr.write(`\nSigned in. ${json.plan[0].toUpperCase()}${json.plan.slice(1)} plan, ${calls}. Saved to ${CONFIG}.\n\n`);
    process.stderr.write(`Try:\n  npx quantisnow search '"material weakness"' --forms 10-K\n  npx quantisnow insiders --min 1m\n  npx quantisnow mcp install claude-code\n\n`);
  } catch (err) {
    fail(err instanceof ApiError ? err.message : `Couldn't check the sign-in: ${err.message}`);
  }
}

async function usage(flags) {
  const key = await needKey(flags);
  try {
    const { json } = await call(key, "usage", null, "GET");
    if (flags.json) return void process.stdout.write(JSON.stringify(json, null, 2) + "\n");
    const name = bold(`${json.plan[0].toUpperCase()}${json.plan.slice(1)} plan`, tty);
    const credits = Number(json.credits ?? 0);
    if (json.callsPerMonth === 0) {
      process.stdout.write(`${name}  ${credits.toLocaleString("en-US")} free calls left.${credits === 0 ? " Pick a plan to keep going:" : " Plans:"} ${KEYS_URL}\n`);
    } else {
      const left = Math.max(0, json.callsPerMonth - json.callsThisMonth);
      process.stdout.write(
        `${name}  ${json.callsThisMonth.toLocaleString("en-US")} of ${json.callsPerMonth.toLocaleString("en-US")} calls this month, ${left.toLocaleString("en-US")} left, resets ${json.resetsOn}\n` +
          (credits > 0 ? `Credits: ${credits.toLocaleString("en-US")} (spent after the monthly calls, never expire)\n` : "") +
          `Up to ${json.requestsPerSecond} requests a second. Manage keys and plans: ${KEYS_URL}\n`,
      );
    }
  } catch (err) {
    fail(err.message);
  }
}

function size(flags) {
  return intFlag(flags.size, 10, 1, 50);
}

async function search(flags, pos) {
  const query = pos.join(" ").trim();
  if (!query) fail('What should it look for? For example: quantisnow search "reverse stock split"');
  const formTypes = typeof flags.forms === "string" ? flags.forms.split(",").map((s) => s.trim()).filter(Boolean) : typeof flags.form === "string" ? [flags.form] : undefined;
  const kinds = typeof flags.kind === "string" ? flags.kind.split(",") : undefined;
  await run(flags, "full-text", {
    query,
    formTypes,
    kinds,
    sort: flags.newest ? "newest" : typeof flags.sort === "string" ? flags.sort : undefined,
    size: size(flags),
    from: intFlag(flags.from, 0, 0),
  });
}

async function ask(flags, pos) {
  const question = pos.join(" ").trim();
  if (!question) fail('Ask something, for example: quantisnow ask "which CFOs resigned this week"');
  const key = await needKey(flags);
  try {
    const out = await call(key, "ask", { question, size: size(flags) });
    if (!flags.json) process.stderr.write(dim(`${out.json.endpoint}  ${out.json.query}\n\n`, process.stderr.isTTY));
    print(out, flags);
  } catch (err) {
    fail(err.message);
  }
}

async function query(flags, pos) {
  const [dataset, ...rest] = pos;
  const ds = DATASETS.find((d) => d.path === dataset);
  if (!ds) fail(`Pick a dataset: ${DATASETS.map((d) => d.path).join(", ")}`);
  const q = rest.join(" ").trim();
  if (!q) fail(`Add a query, for example: quantisnow query insider-trades "formType:4 AND transactionCodes:P"`);
  let sort;
  if (typeof flags.sort === "string") {
    const [field, order = "desc"] = flags.sort.split(":");
    sort = [{ [field]: { order } }];
  }
  await run(flags, ds.path, { query: q, size: size(flags), from: intFlag(flags.from, 0, 0), sort });
}

function datasets() {
  for (const d of DATASETS) process.stdout.write(`${bold(d.path.padEnd(16), tty)} ${d.about}\n`);
  process.stdout.write(`${bold("full-text".padEnd(16), tty)} Words inside filings and exhibits (quantisnow search)\n`);
  process.stdout.write(dim(`\nFields for each: https://www.quantisnow.com/sec-api\n`, tty));
}

async function shortcut(name, flags, pos) {
  const days = flags.days === undefined ? undefined : intFlag(flags.days, 30, 1, 3650);
  const min = intFlag(flags.min, 0, 0);
  let req;
  try {
    if (name === "insiders") {
      const side = flags.sells ? "sells" : flags.all ? "all" : "buys";
      req = ["insider-trades", insidersQuery({ symbol: pos[0], side, min, days: days ?? (pos[0] ? 180 : 30), form: flags.form144 ? "144" : "4" })];
    } else if (name === "filings") {
      req = ["filings", filingsQuery({ symbol: pos[0], form: typeof flags.form === "string" ? flags.form : undefined, days: days ?? 90 })];
    } else if (name === "events") {
      req = ["8-k/events", eventsQuery({ item: pos[0], symbol: pos[1], days: days ?? 30 })];
    } else if (name === "holders") {
      req = ["13f/holdings", holdersQuery({ symbol: pos[0], change: typeof flags.change === "string" ? flags.change : undefined, period: typeof flags.period === "string" ? flags.period : undefined })];
    } else if (name === "financials") {
      req = ["financials", financialsQuery({ symbol: pos[0], annual: Boolean(flags.annual) })];
    } else {
      req = ["congress/trades", congressQuery({ symbol: pos[0], days: days ?? 365, min })];
    }
  } catch (err) {
    fail(err.message);
  }
  const [path, body] = req;
  if (flags.showQuery) process.stderr.write(dim(`${path}  ${body.query}\n`, process.stderr.isTTY));
  await run(flags, path, { ...body, size: size(flags) });
}

// ---- MCP ----

// A stdio MCP server that forwards every JSON-RPC message to the hosted
// Streamable HTTP server. For clients that only start local commands.
async function mcpBridge(flags) {
  if (!(await credential(flags))) fail("Set QUANTISNOW_API_KEY or run npx quantisnow login first.");
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let protocol = null;
  let queue = Promise.resolve();
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    queue = queue.then(async () => {
      try {
        const key = await credential(flags);
        const res = await fetch(MCP_URL, {
          method: "POST",
          headers: {
            authorization: `Bearer ${key}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "user-agent": UA,
            ...(protocol ? { "mcp-protocol-version": protocol } : {}),
          },
          body: JSON.stringify(msg),
        });
        const body = await res.text();
        if (!res.ok && msg.id !== undefined) {
          let m = `HTTP ${res.status}`;
          try {
            m = JSON.parse(body)?.error?.message ?? m;
          } catch {
            /* plain */
          }
          return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: m } });
        }
        for (const out of parseMcpBody(res.headers.get("content-type"), body)) {
          if (msg.method === "initialize" && out.result?.protocolVersion) protocol = out.result.protocolVersion;
          send(out);
        }
      } catch (err) {
        if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: `Couldn't reach Quantisnow: ${err.message}` } });
      }
    });
  });
  rl.on("close", () => void queue.then(() => process.exit(0)));
}

function which(bin) {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function mcpInstall(flags, pos) {
  const client = pos[0];
  if (!MCP_CLIENTS.includes(client)) {
    fail(`Which client? npx quantisnow mcp install <${MCP_CLIENTS.join("|")}>\nOr add ${MCP_URL} with the header "Authorization: Bearer <key>" to any MCP client.`);
  }
  const oauth = usingOAuth(flags) || flags.oauth;
  const key = oauth ? null : await needKey(flags);
  const say = (s) => process.stderr.write(s + "\n");

  if (client === "claude-code") {
    const args = ["mcp", "add", "--transport", "http", "--scope", flags.scope ?? "user", "quantisnow", MCP_URL, ...(key ? ["--header", `Authorization: Bearer ${key}`] : [])];
    if (which("claude") && !flags.print) {
      try {
        execFileSync("claude", ["mcp", "remove", "--scope", flags.scope ?? "user", "quantisnow"], { stdio: "ignore" });
      } catch {
        /* not there yet */
      }
      execFileSync("claude", args, { stdio: "inherit" });
      say(`\nDone. Start claude${key ? "" : ", run /mcp and sign in to quantisnow,"} then ask: "Which insiders bought more than $1M of stock this week?"`);
    } else {
      say(`Run this:\n\n  claude ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}\n`);
    }
    return;
  }

  if (client === "codex") {
    const path = join(homedir(), ".codex", "config.toml");
    const block = `\n[mcp_servers.quantisnow]\ncommand = "npx"\nargs = ["-y", "quantisnow", "mcp"]\n${key ? `env = { QUANTISNOW_API_KEY = "${key}" }\n` : ""}`;
    const have = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (have.includes("[mcp_servers.quantisnow]")) return say(`${path} already has a quantisnow server. Edit it there to change the key.`);
    if (flags.print) return say(`Add to ${path}:\n${block}`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, have + block);
    return say(`Added quantisnow to ${path}. Restart Codex.`);
  }

  if (client === "vscode") {
    const entry = { name: "quantisnow", ...httpEntry(key) };
    if (which("code") && !flags.print) {
      execFileSync("code", ["--add-mcp", JSON.stringify(entry)], { stdio: "inherit" });
      return say("Added quantisnow to VS Code. Open Copilot Chat in Agent mode and ask about any SEC filing.");
    }
    return say(`Add to .vscode/mcp.json under "servers":\n\n${JSON.stringify({ servers: { quantisnow: httpEntry(key) } }, null, 2)}\n`);
  }

  const path = configPath(client, { home: homedir(), appData: process.env.APPDATA ?? "" });
  let existing = {};
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, "utf8") || "{}");
    } catch {
      fail(`${path} isn't valid JSON, so it was left alone. Fix it, or add this under "mcpServers":\n${JSON.stringify({ quantisnow: client === "claude-desktop" ? stdioEntry(key) : httpEntry(key) }, null, 2)}`);
    }
  }
  const next = mergeConfig(client, existing, key);
  if (flags.print) return say(`${path}:\n\n${JSON.stringify(next, null, 2)}`);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) writeFileSync(`${path}.bak`, readFileSync(path));
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
  const names = { "claude-desktop": "Claude Desktop", cursor: "Cursor", windsurf: "Windsurf", gemini: "Gemini CLI" };
  say(`Added quantisnow to ${path}${existsSync(`${path}.bak`) ? ` (old file kept as ${path}.bak)` : ""}.`);
  say(`Restart ${names[client]} and ask: "Show me 8-Ks filed this week where a CFO resigned."`);
}

// ---- Main ----

const BOOLS = ["json", "help", "sells", "all", "annual", "newest", "print", "noLinks", "noBrowser", "showQuery", "form144", "version", "paste", "oauth"];

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, pos } = parseArgs(rest, BOOLS);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") return void process.stdout.write(HELP);
  if (cmd === "--version" || cmd === "-v" || cmd === "version") return void process.stdout.write(`${VERSION}\n`);
  if (flags.help) return void process.stdout.write(HELP);
  switch (cmd) {
    case "login":
      return login(flags);
    case "logout": {
      const cfg = readConfig();
      const refresh = cfg.oauth?.refreshToken;
      if (refresh) await fetch(`${SITE}/api/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: refresh }) }).catch(() => null);
      delete cfg.apiKey;
      delete cfg.oauth;
      saveConfig(cfg);
      return void process.stderr.write(`Signed out. Removed the saved sign-in from ${CONFIG}.\n`);
    }
    case "whoami": {
      if (usingOAuth(flags)) return void process.stdout.write(`Signed in through the browser (${CONFIG})\n`);
      const key = await credential(flags);
      return void process.stdout.write(key ? `${maskKey(key)} (${flags.key ? "--key" : process.env.QUANTISNOW_API_KEY ? "QUANTISNOW_API_KEY" : CONFIG})\n` : "Not signed in. Run npx quantisnow login.\n");
    }
    case "usage":
      return usage(flags);
    case "search":
    case "fts":
      return search(flags, pos);
    case "ask":
      return ask(flags, pos);
    case "query":
      return query(flags, pos);
    case "datasets":
      return datasets();
    case "insiders":
    case "filings":
    case "events":
    case "holders":
    case "financials":
    case "congress":
      return shortcut(cmd, flags, pos);
    case "mcp":
      if (pos[0] === "install" || pos[0] === "add") return mcpInstall(flags, pos.slice(1));
      if (pos[0] === "url") return void process.stdout.write(`${MCP_URL}\n`);
      return mcpBridge(flags);
    default:
      fail(`Unknown command "${cmd}". Run npx quantisnow help.`);
  }
}

main().catch((err) => fail(err?.message ?? String(err)));
