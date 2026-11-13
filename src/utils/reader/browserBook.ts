const sharedReader = window.location.hostname === "127.0.0.1" &&
  /^\/[a-f0-9]{48}\/[a-f0-9]{64}\/index\.html$/.test(window.location.pathname);

export const isBrowserBook = sharedReader;

export function translationUrl(path: string) {
  const endpoint = `api/translation${path}`;
  return sharedReader ? new URL(endpoint, window.location.href).href : "/" + endpoint;
}
