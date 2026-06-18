// api.ts — typed client for the Netlify functions.

export interface Party {
  id: string;
  name: string;
}
export interface Track {
  key: string;
  name: string;
  url: string; // presigned download URL
}

async function jsonOrThrow(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any).error || res.statusText);
  return data;
}

export const api = {
  parties: () => fetch('/api/parties').then(jsonOrThrow) as Promise<{ parties: Party[] }>,

  playlist: (party: string) =>
    fetch(`/api/playlist?party=${encodeURIComponent(party)}`).then(jsonOrThrow) as Promise<{
      tracks: Track[];
    }>,

  // roomName == party id (one LiveKit room per party, used only for the sync channel).
  token: (party: string, name: string, isHost: boolean, password?: string) =>
    fetch('/api/get-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomName: party, participantName: name, isHost, password })
    }).then(jsonOrThrow) as Promise<{ token: string; url: string }>,

  uploadUrl: (party: string, filename: string, contentType: string, size: number, password: string) =>
    fetch('/api/upload-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ party, filename, contentType, size, password })
    }).then(jsonOrThrow) as Promise<{ url: string; key: string; contentType: string }>
};
