/** An error in a person's words: Electron's "Error invoking remote method '…': Error:" taken off.
 * Its own file so a page that doesn't load the store (Setup) can use it too. */
export function errorText(e: unknown): string {
  return String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}
