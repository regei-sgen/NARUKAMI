/** The command shape Claude Code returns for a project. */
export interface AnalyzerCommand {
  label: string;
  command: string;
  isDefault: boolean;
}

/** The full analysis object Claude Code returns (after we normalize it). */
export interface AnalyzerResult {
  type: string;
  packageManager: string;
  installCommand: string | null;
  commands: AnalyzerCommand[];
  envVarsNeeded: string[];
  warnings: string[];
}

/** One place the embedded Chromium preview will diverge from the real target browser. */
export interface AccuracyFinding {
  area: string;
  severity: 'high' | 'medium' | 'low';
  note: string;
  fix: string;
  /** 'catalog' = from the curated built-in reference; 'claude' = found by Claude in this project's code. */
  source: 'catalog' | 'claude';
}

/** Cross-browser accuracy report for one preview (target engine vs. the Chromium preview). */
export interface AccuracyReport {
  /** Human name of the emulated browser the report is about (e.g. "Safari (iOS)"). */
  engine: string;
  summary: string;
  findings: AccuracyFinding[];
}
