export interface PlatformCommand {
  executable: string;
  args: string[];
}

export interface TerminationStatus {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export function isCleanTermination(status: TerminationStatus, platform?: NodeJS.Platform): boolean;

export function createPlatformCommand(
  executable: string,
  args: readonly string[],
  platform?: NodeJS.Platform,
  commandInterpreter?: string,
): PlatformCommand;
