/**
 * The bit of the Wails runtime the UI uses. Wails injects `window.runtime` into
 * the desktop webview; in a browser it is absent.
 */
interface Window {
  runtime?: {
    BrowserOpenURL?: (url: string) => void;
  };
}
