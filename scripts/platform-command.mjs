const CMD_META_CHARACTERS = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdCommand(value) {
  return value.replace(CMD_META_CHARACTERS, "^$1");
}

function escapeCmdArgument(value) {
  let escaped = value.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  escaped = escaped.replace(/(?=(\\+?)?)\1$/g, "$1$1");
  escaped = `"${escaped}"`.replace(CMD_META_CHARACTERS, "^$1");
  // A .cmd shim reparses its expanded arguments, so metacharacters need a second caret layer.
  return escaped.replace(CMD_META_CHARACTERS, "^$1");
}

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
    const commandLine = [escapeCmdCommand(executable), ...args.map(escapeCmdArgument)].join(" ");
    return {
      executable: commandInterpreter,
      args: ["/d", "/s", "/c", `"${commandLine}"`],
    };
  }
  return { executable, args: [...args] };
}
