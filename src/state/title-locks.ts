/**
 * The titles a `media` call is removing, one call at a time per title.
 *
 * Two removals of one title that overlap would both read it in the library
 * before either deletes it, and an instance that answers a repeated delete
 * with success would let both report it removed. So a removal runs only once
 * every earlier removal of the same title has settled, and then reads the
 * library again: a title the earlier call removed is gone by then, and the
 * later call reports it `not_in_library` without sending a delete.
 *
 * It is process memory, held by the workflow state and shared by the stdio
 * session and every HTTP request alike, as the download claims are. It holds
 * an entry only while a removal of that title is running or waiting, so it
 * is bounded by the calls in flight rather than by the library.
 */
export interface TitleLocks {
  /** Runs `action` once every earlier action under `key` has settled, however it settled. */
  run<TResult>(key: string, action: () => Promise<TResult>): Promise<TResult>;
  /** How many titles have an action running or waiting. */
  readonly size: number;
}

export function createTitleLocks(): TitleLocks {
  const tails = new Map<string, Promise<unknown>>();

  return {
    run(key, action) {
      const previous = tails.get(key) ?? Promise.resolve();
      // Waits for the previous action whether it succeeded or failed: a
      // failed removal still has to settle before the next one reads.
      const result = previous.then(action, action);
      const tail = result.catch(() => undefined);
      tails.set(key, tail);
      void tail.then(() => {
        // Only the last action queued under a key clears it.
        if (tails.get(key) === tail) {
          tails.delete(key);
        }
      });
      return result;
    },
    get size() {
      return tails.size;
    },
  };
}
