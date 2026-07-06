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
