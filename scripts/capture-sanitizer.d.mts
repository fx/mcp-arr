export declare function createSanitizer(
  screen: (value: unknown, location: string, ...rest: never[]) => void,
  fail: (message: string) => never,
): {
  readonly sanitize: (value: unknown) => unknown;
  readonly replacements: ReadonlyMap<string, string>;
};
