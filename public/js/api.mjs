// fetch wrapper: always resolves to { ok, status, data, error } with a French
// error message (the server's own when it sent one).

export async function api(method, url, body) {
  const init = { method, credentials: 'same-origin', headers: { accept: 'application/json' } };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(url, init);
  } catch {
    return { ok: false, status: 0, data: null, error: 'Connexion impossible. Vérifiez votre réseau puis réessayez.' };
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    // Empty or non-JSON body: keep data null.
  }
  if (!response.ok) {
    return { ok: false, status: response.status, data, error: data?.error ?? `Erreur inattendue (${response.status}).` };
  }
  return { ok: true, status: response.status, data, error: null };
}
