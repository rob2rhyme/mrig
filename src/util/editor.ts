/**
 * The user's editor, for `/notes edit` (M1): $VISUAL, then $EDITOR, then Notepad on Windows or
 * vi elsewhere. A value with arguments (`code --wait`) is split on spaces; the file goes last.
 */
export function editorCommand(
  file: string,
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): string[] {
  const chosen = (env.VISUAL || env.EDITOR || '').trim();
  const words = chosen ? chosen.split(/\s+/) : [platform === 'win32' ? 'notepad' : 'vi'];
  return [...words, file];
}
