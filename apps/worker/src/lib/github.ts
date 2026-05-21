import { createSign, createPrivateKey } from 'crypto';

// ── App JWT (10-min validity) ────────────────────────────────────────────────

export function generateAppJWT(): string {
  const appId = process.env.GITHUB_APP_ID;
  const pemRaw = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !pemRaw) throw new Error('GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY not configured');

  const privateKey = pemRaw.replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId })).toString('base64url');
  const unsigned = `${header}.${body}`;
  const sign = createSign('RSA-SHA256');
  sign.update(unsigned);
  const signature = sign.sign(createPrivateKey(privateKey)).toString('base64url');
  return `${unsigned}.${signature}`;
}

// ── Installation token (1-hour validity) ─────────────────────────────────────

export async function getInstallationToken(installationId: number): Promise<string> {
  const jwt = generateAppJWT();
  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(10_000),
    }
  );
  if (!res.ok) throw new Error(`Failed to get installation token: ${res.status}`);
  const data = (await res.json()) as { token: string };
  return data.token;
}

// ── File / tree fetchers ─────────────────────────────────────────────────────

export async function fetchFileContent(
  token: string,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
    {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3.raw',
      },
      signal: AbortSignal.timeout(10_000),
    }
  );
  if (!res.ok) return null;
  return res.text();
}

export async function getPRFiles(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<Array<{ filename: string; status: string }>> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`,
    {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(10_000),
    }
  );
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  return res.json() as Promise<Array<{ filename: string; status: string }>>;
}

export async function getRepoFileTree(
  token: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<Array<{ path: string; type: string }>> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(30_000),
    }
  );
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const data = (await res.json()) as { tree: Array<{ path: string; type: string }>; truncated?: boolean };
  if (data.truncated) console.warn(`[github] tree truncated for ${owner}/${repo}@${branch}`);
  return data.tree.filter((f) => f.type === 'blob');
}
