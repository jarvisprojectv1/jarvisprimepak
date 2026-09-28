// core/skills/staticAnalysis.ts - Skill Security static analysis (Phase 6,
// item 13). A real (if simple) text-pattern scan over a candidate skill's
// source text, rejecting on any hit. This is NOT a full security audit (no
// AST parsing, no data-flow analysis) - it is an honest, documented
// first-pass filter for the most dangerous, unambiguous capability patterns:
// dynamic code execution, process spawning, and raw filesystem/network
// access outside anything JARVIS already mediates through its own tool
// registry. A candidate that trips any pattern is REJECTED, never merely
// flagged - see core/skills/registry.ts's lifecycle (REJECTED is terminal).
export interface StaticAnalysisFinding {
  pattern: string;
  excerpt: string;
}

export interface StaticAnalysisResult {
  passed: boolean;
  findings: StaticAnalysisFinding[];
}

const DANGEROUS_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "eval", re: /\beval\s*\(/ },
  { name: "new_function", re: /new\s+Function\s*\(/ },
  { name: "child_process", re: /require\(\s*['"]child_process['"]\s*\)|from\s+['"]child_process['"]/ },
  { name: "fs_module", re: /require\(\s*['"]fs['"]\s*\)|from\s+['"]fs['"]/ },
  { name: "network_module", re: /require\(\s*['"]net['"]\s*\)|require\(\s*['"]http['"]\s*\)|require\(\s*['"]https['"]\s*\)/ },
  { name: "process_exit_or_env", re: /process\.(exit|env|binding)\b/ },
  { name: "dynamic_import", re: /import\s*\(\s*[^'"]/ }, // import() with a non-literal (computed) specifier
  { name: "vm_module", re: /require\(\s*['"]vm['"]\s*\)|from\s+['"]vm['"]/ },
];

/** Scans candidate skill source text for known-dangerous patterns. Never executes the text. */
export function runStaticAnalysis(sourceText: string): StaticAnalysisResult {
  const findings: StaticAnalysisFinding[] = [];
  for (const { name, re } of DANGEROUS_PATTERNS) {
    const match = re.exec(sourceText);
    if (match) {
      const start = Math.max(0, match.index - 20);
      findings.push({ pattern: name, excerpt: sourceText.slice(start, start + 80) });
    }
  }
  return { passed: findings.length === 0, findings };
}
