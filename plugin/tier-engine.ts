/**
 * Tier Engine — Compiles declarative JSON rules into a classifier.
 * 
 * Rule format:
 *   tool: string | string[] | "*"         — tool name(s) to match
 *   tier: 0-4                              — risk tier
 *   params: { key: value | value[] }       — match params (all must match)
 *   commandPattern: string                 — regex match on params.command (for exec)
 *   contextKey: string                     — template with {tool}, {params.X}, {params.X|Y|default}
 *   name: string                           — human-readable rule name (for debugging)
 */

export type Tier = 0 | 1 | 2 | 3 | 4;

export interface TierRuleConfig {
  name?: string;
  tier: Tier;
  tool: string | string[];
  params?: Record<string, string | string[]>;
  commandPattern?: string;
  contextKey?: string;
}

export interface TierRulesConfig {
  description?: string;
  rules: TierRuleConfig[];
}

interface CompiledRule {
  name: string;
  tier: Tier;
  toolMatch: (tool: string) => boolean;
  paramsMatch: (params: Record<string, unknown>) => boolean;
  commandRegex?: RegExp;
  contextKeyTemplate?: string;
}

function compileRule(rule: TierRuleConfig, index: number): CompiledRule {
  const name = rule.name || `rule-${index}`;

  // Tool matcher
  let toolMatch: (t: string) => boolean;
  if (rule.tool === "*") {
    toolMatch = () => true;
  } else if (Array.isArray(rule.tool)) {
    const set = new Set(rule.tool);
    toolMatch = (t) => set.has(t);
  } else {
    toolMatch = (t) => t === rule.tool;
  }

  // Params matcher
  let paramsMatch: (p: Record<string, unknown>) => boolean;
  if (rule.params) {
    const checks = Object.entries(rule.params).map(([key, expected]) => {
      const values = Array.isArray(expected) ? expected : [expected];
      return (p: Record<string, unknown>) => values.includes(String(p[key] ?? ""));
    });
    paramsMatch = (p) => checks.every((check) => check(p));
  } else {
    paramsMatch = () => true;
  }

  // Command regex (for exec tools)
  let commandRegex: RegExp | undefined;
  if (rule.commandPattern) {
    commandRegex = new RegExp(rule.commandPattern);
  }

  return {
    name,
    tier: rule.tier,
    toolMatch,
    paramsMatch,
    commandRegex,
    contextKeyTemplate: rule.contextKey,
  };
}

/**
 * Resolve a context key template like "channel:{params.target|params.channel|unknown}"
 */
function resolveTemplate(template: string, tool: string, params: Record<string, unknown>): string {
  return template.replace(/\{([^}]+)\}/g, (_, expr: string) => {
    const alternatives = expr.split("|").map((s: string) => s.trim());
    for (const alt of alternatives) {
      if (alt === "tool") return tool;
      if (alt.startsWith("params.")) {
        const key = alt.slice(7);
        const val = params[key];
        if (val !== undefined && val !== null && val !== "") return String(val);
      }
      if (alt === "commandRecipient") {
        const cmd = String(params.command || "");
        const match = cmd.match(/--mail-rcpt\s+'?([^'\s]+)/);
        if (match) return match[1];
        // Try --to flag
        const toMatch = cmd.match(/--to\s+'?([^'\s]+)/);
        if (toMatch) return toMatch[1];
        return "unknown";
      }
      // Literal fallback (no prefix)
      if (!alt.includes(".")) return alt;
    }
    return "unknown";
  });
}

export class TierEngine {
  private rules: CompiledRule[];

  constructor(config: TierRulesConfig) {
    this.rules = config.rules.map((r, i) => compileRule(r, i));
  }

  classify(tool: string, params: Record<string, unknown>): { tier: Tier; contextKey: string | null; ruleName: string } {
    for (const rule of this.rules) {
      if (!rule.toolMatch(tool)) continue;
      if (!rule.paramsMatch(params)) continue;
      if (rule.commandRegex) {
        const cmd = String(params.command || "");
        if (!rule.commandRegex.test(cmd)) continue;
      }

      const contextKey = rule.contextKeyTemplate
        ? resolveTemplate(rule.contextKeyTemplate, tool, params)
        : null;

      return { tier: rule.tier, contextKey, ruleName: rule.name };
    }
    return { tier: 0, contextKey: null, ruleName: "default-fallback" };
  }

  /** Load rules from a JSON file */
  static fromFile(path: string): TierEngine {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as TierRulesConfig;
    return new TierEngine(raw);
  }

  /** Merge user overrides on top of defaults. User rules are prepended (higher priority). */
  static merge(defaults: TierRulesConfig, overrides: TierRuleConfig[]): TierRulesConfig {
    return {
      description: defaults.description,
      rules: [...overrides, ...defaults.rules],
    };
  }

  get ruleCount(): number {
    return this.rules.length;
  }

  get ruleNames(): string[] {
    return this.rules.map((r) => r.name);
  }
}

import { readFileSync } from "fs";
