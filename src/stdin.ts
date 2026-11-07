/**
 * Holds or releases the event loop on stdin, where stdin can be held at all.
 *
 * Node gives a process a socket for stdin when it is a pipe or a terminal, and
 * a file stream when it is a file — which is what `/dev/null` is, and what a
 * container started without an attached stdin hands the process. A file stream
 * has neither `ref` nor `unref`, and it never holds the event loop open in the
 * first place, so there is nothing to do for one. Calling either method
 * unguarded throws there instead, before any diagnostic can be written.
 */
function referableStdin(): { ref(): void; unref(): void } | undefined {
  const stdin: { readonly ref?: unknown; readonly unref?: unknown } = process.stdin;
  return typeof stdin.ref === "function" && typeof stdin.unref === "function"
    ? process.stdin
    : undefined;
}

export function refStdin(): void {
  referableStdin()?.ref();
}

export function unrefStdin(): void {
  referableStdin()?.unref();
}
