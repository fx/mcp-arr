export function createPlatformCommand(
  executable,
  args,
  platform = process.platform,
  commandInterpreter = process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe",
) {
  if (platform === "win32" && executable.toLowerCase().endsWith(".cmd")) {
    return {
      executable: commandInterpreter,
      args: ["/d", "/s", "/c", executable, ...args],
    };
  }
  return { executable, args: [...args] };
}
