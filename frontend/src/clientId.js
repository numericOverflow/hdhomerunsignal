// Random ID for this browser. The backend uses it to know which test-tuned
// tuners belong to this browser, also across socket reconnects.
const STORAGE_KEY = 'hdhr-client-id';

function createId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

let clientId = null;

export function getClientId() {
  if (clientId) return clientId;
  try {
    clientId = localStorage.getItem(STORAGE_KEY);
    if (!clientId) {
      clientId = createId();
      localStorage.setItem(STORAGE_KEY, clientId);
    }
  } catch (error) {
    clientId = clientId || createId();
  }
  return clientId;
}
