// Preloaded by every local API demo process. This application uses fetch for
// outbound HTTP; reject remote destinations before its native implementation.
export function localOnlyFetch(nativeFetch) {
  return async function guardedFetch(input, init) {
    let url;
    try { url = new URL(input instanceof Request ? input.url : String(input)); }
    catch { throw new Error('Local API demo: invalid request URL.'); }
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) {
      throw new Error('Local API demo: remote network requests are disabled.');
    }
    return nativeFetch(input, { ...init, redirect: 'error' });
  };
}

globalThis.fetch = localOnlyFetch(globalThis.fetch);
process.env.AI_ENABLED = 'false';
process.env.OPENAI_API_KEY = '';
process.env.API_NETWORK_POLICY = 'loopback-only';
