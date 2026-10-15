// The ONLY data the Zoom App sends to our backend: a short single-use nonce and the meeting UUID.
// No Zoom tokens, no client secret, no user identity, no participant list.
export function createAssociationClient({ baseUrl, fetchImpl = globalThis.fetch }) {
  return {
    async associate({ nonce, meetingUUID }) {
      const body = JSON.stringify({ nonce, meetingUUID });
      let res;
      try { res = await fetchImpl(`${baseUrl}/v1/association`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, credentials: 'omit' }); }
      catch { return { ok: false, reason: 'network' }; }
      if (!res.ok) { let reason = 'rejected'; try { reason = (await res.json()).error ?? reason; } catch { /* ignore */ } return { ok: false, reason }; }
      return { ok: true };
    },
  };
}
