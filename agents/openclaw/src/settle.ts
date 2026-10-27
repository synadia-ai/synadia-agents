/**
 * Wait for `work` at most `ms`: true when it settled in time, resolved or
 * rejected, false when the time ran out first. The work is not cancelled.
 * Its outcome is observed either way, so a rejection after the time ran
 * out is never unhandled. With `ms` at 0 or less, work that settles within
 * the current turn of the event loop still counts as in time.
 */
export async function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, ms));
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
