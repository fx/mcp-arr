export interface PlatformCommand {
  executable: string;
  args: string[];
}

export function createPlatformCommand(
  executable: string,
  args: readonly string[],
  platform?: NodeJS.Platform,
  commandInterpreter?: string,
): PlatformCommand;
