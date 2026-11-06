// File imports (`with { type: 'file' }`) for the web app's static files: Bun embeds them in the
// compiled binary and the import gives a path that Bun.file() can read.
declare module '*.png' {
  const path: string;
  export default path;
}
declare module '*.webmanifest' {
  const path: string;
  export default path;
}
declare module '*/sw.js' {
  const path: string;
  export default path;
}
declare module '*.svg' {
  const path: string;
  export default path;
}
