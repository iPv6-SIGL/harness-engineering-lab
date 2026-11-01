#!/usr/bin/env bun
// mcp/platform/server.ts — the capability graph served to the coding agent over
// MCP (stdio, JSON-RPC 2.0, one message per line). The agent ASKS the platform
// what exists and what it costs instead of guessing from memory:
//
//   list_bricks()            → every brick, its price and what buys it
//   explain(brick)           → use_when, not_when, costs, switch, sources
//   price(bricks[])          → the bill of a set of bricks against a budget class
//   need_test(text, volume?) → which needs a requirement's text emits, which are vetoed
//
// Rebuilt from the platform's files at startup — never a hand-made copy.
// Wire it in .mcp.json: {"mcpServers":{"platform":{"command":"bun","args":["../harness/mcp/platform/server.ts"]}}}
import { buildGraph } from "../../src/catalog";
import { needTest } from "../../src/needs";

const g = buildGraph();

const TOOLS = [
  { name: "list_bricks", description: "Every platform brick with its ops-point price and the needs that can buy it.", inputSchema: { type: "object", properties: {} } },
  {
    name: "explain",
    description: "When a brick earns its place, when it does not, what it costs to run, how an app switches it on, and where the platform documents it.",
    inputSchema: { type: "object", properties: { brick: { type: "string", enum: Object.keys(g.bricks) } }, required: ["brick"] },
  },
  {
    name: "price",
    description: "Ops points of a set of bricks (scaffold included) against an app-class budget.",
    inputSchema: { type: "object", properties: { bricks: { type: "array", items: { type: "string" } }, class: { type: "string", enum: Object.keys(g.classes) } }, required: ["bricks"] },
  },
  {
    name: "need_test",
    description: "Run the need test on one requirement: the signals it emits, the needs it pays for, the counter-signals that veto a tempting brick.",
    inputSchema: { type: "object", properties: { text: { type: "string" }, volume: { type: "number", description: "units of work triggered by one action" } }, required: ["text"] },
  },
];

function call(name: string, a: Record<string, any>): unknown {
  switch (name) {
    case "list_bricks":
      return Object.values(g.bricks).map((b) => ({ brick: b.brick, ops_points: b.ops_points, price_assumed: b.price_assumed, scaffold: b.scaffold, bought_by: b.bought_by }));
    case "explain": {
      const b = g.bricks[a.brick];
      if (!b) throw new Error(`unknown brick ${a.brick}`);
      return { brick: b.brick, use_when: b.use_when, not_when: b.not_when, costs: b.costs, ops_points: b.ops_points, switch: b.switch, requires: b.requires, container: b.container, aliases: b.aliases, sources: b.sources, bought_by: b.bought_by };
    }
    case "price": {
      const scaffold = Object.values(g.bricks).filter((b) => b.scaffold).map((b) => b.brick);
      const bricks = [...new Set([...scaffold, ...a.bricks])];
      for (const b of bricks) if (!g.bricks[b]) throw new Error(`unknown brick ${b}`);
      const total = bricks.reduce((s, b) => s + g.bricks[b].ops_points, 0);
      const klass = g.classes[a.class ?? "crud"];
      return { bricks, total, class: a.class ?? "crud", budget: klass.budget, within_budget: total <= klass.budget };
    }
    case "need_test": {
      const bill = needTest({ app: "probe", version: 1, prompt: "", personas: [], anonymous: true, requirements: [{ id: "R", text: a.text, volume: a.volume }] }, g);
      return { signals: bill.hits.R, needs: Object.keys(bill.needs), vetoed: bill.vetoed.map((v) => ({ need: v.need, rule: v.rule, why: v.why, avoids: v.avoids })), would_buy: bill.bought.map((b) => b.brick), unsupported: bill.unsupported };
    }
  }
  throw new Error(`unknown tool ${name}`);
}

function reply(id: unknown, result?: unknown, error?: { code: number; message: string }) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) })}\n`);
}

let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let nl = buffer.indexOf("\n");
  while (nl >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    nl = buffer.indexOf("\n");
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue; // notifications (initialized, cancelled)
    try {
      if (msg.method === "initialize") reply(msg.id, { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "platform", version: "1.0.0" } });
      else if (msg.method === "tools/list") reply(msg.id, { tools: TOOLS });
      else if (msg.method === "tools/call") reply(msg.id, { content: [{ type: "text", text: JSON.stringify(call(msg.params.name, msg.params.arguments ?? {}), null, 2) }] });
      else if (msg.method === "ping") reply(msg.id, {});
      else reply(msg.id, undefined, { code: -32601, message: `method not found: ${msg.method}` });
    } catch (e) {
      reply(msg.id, { content: [{ type: "text", text: String(e) }], isError: true });
    }
  }
}
