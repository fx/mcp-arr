export function isCleanTermination(status, platform = process.platform) {
  if (status.code === 0 && status.signal === null) {
    return true;
  }
  return platform === "win32" && status.code === null && status.signal === "SIGTERM";
}

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
