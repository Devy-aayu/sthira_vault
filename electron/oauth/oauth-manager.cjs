const http = require('node:http');
const crypto = require('node:crypto');
const { shell, safeStorage } = require('electron');
const { getOAuthApps } = require('./oauth-apps.cjs');
const {
  createPkce,
  encryptJson,
  fetchJson,
  formBody
} = require('./oauth-utils.cjs');

let activeFlow = false;

function decryptOptional(value) {
  if (!value) return '';
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure provider configuration storage is unavailable.');
  }
  return safeStorage.decryptString(Buffer.from(value, 'base64'));
}

function runtimeOAuthConfiguration(state) {
  const configured = state.settings?.oauthApps || {};
  return {
    google: {
      clientId: configured.google?.clientId || '',
      clientSecret: decryptOptional(configured.google?.clientSecretEncrypted || '')
    },
    microsoft: {
      clientId: configured.microsoft?.clientId || ''
    },
    dropbox: {
      clientId: configured.dropbox?.clientId || ''
    },
    pcloud: {
      clientId: configured.pcloud?.clientId || ''
    }
  };
}

function htmlResult(title, detail) {
  const safeTitle = String(title).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const safeDetail = String(detail).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeTitle}</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#08101d;color:#f5f7fb;display:grid;place-items:center;min-height:100vh;margin:0}
main{max-width:540px;padding:32px;border:1px solid #294066;border-radius:18px;background:#0f1a2b;text-align:center}
h1{margin-top:0}p{color:#a8b7cb;line-height:1.6}
</style>
</head>
<body><main><h1>${safeTitle}</h1><p>${safeDetail}</p></main></body>
</html>`;
}

async function createLoopbackReceiver({ redirectHost, callbackPath = '/', port = 0 }) {
  let resolveCallback;
  let rejectCallback;
  const callbackPromise = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const server = http.createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url, `http://${redirectHost}`);
      if (requestUrl.pathname !== callbackPath) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Not found');
        return;
      }

      const error = requestUrl.searchParams.get('error');
      if (error) {
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(htmlResult('Cloud connection canceled', requestUrl.searchParams.get('error_description') || error));
      } else {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(htmlResult('Cloud account connected', 'You can close this browser tab and return to Cloud Backup App.'));
      }
      resolveCallback(requestUrl);
    } catch (error) {
      rejectCallback(error);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  const address = server.address();
  const redirectUri = `http://${redirectHost}:${address.port}${callbackPath}`;
  const timeout = setTimeout(() => {
    rejectCallback(new Error('Cloud sign-in timed out. Try connecting again.'));
    server.close();
  }, 5 * 60 * 1000);
  timeout.unref?.();

  return {
    redirectUri,
    async wait() {
      try {
        return await callbackPromise;
      } finally {
        clearTimeout(timeout);
        server.close();
      }
    },
    close() {
      clearTimeout(timeout);
      server.close();
    }
  };
}

async function createFragmentLoopbackReceiver({ callbackPath, port }) {
  let resolveCallback;
  let rejectCallback;
  const callbackPromise = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const completePath = `${callbackPath}/complete`;
  const server = http.createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && requestUrl.pathname === callbackPath) {
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; connect-src http://127.0.0.1:*; style-src 'unsafe-inline'"
        });
        response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connecting pCloud</title><style>body{font-family:system-ui;background:#08101d;color:#f5f7fb;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:540px;padding:32px;border:1px solid #294066;border-radius:18px;background:#0f1a2b;text-align:center}p{color:#a8b7cb}</style></head><body><main><h1>Connecting pCloud</h1><p id="status">Finishing secure sign-in…</p></main><script>(async()=>{const params=Object.fromEntries(new URLSearchParams(location.hash.slice(1)));const response=await fetch(${JSON.stringify(completePath)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(params)});document.getElementById('status').textContent=response.ok?'Account connected. You can close this tab.':'Could not complete sign-in. Return to the app and try again.';history.replaceState(null,'',location.pathname);})().catch(()=>{document.getElementById('status').textContent='Could not complete sign-in. Return to the app and try again.';});</script></body></html>`);
        return;
      }

      if (request.method === 'POST' && requestUrl.pathname === completePath) {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk) => {
          body += chunk;
          if (body.length > 16_384) request.destroy();
        });
        request.on('end', () => {
          try {
            const payload = JSON.parse(body || '{}');
            response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            response.end(JSON.stringify({ ok: true }));
            resolveCallback(payload);
          } catch (error) {
            response.writeHead(400, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ ok: false }));
            rejectCallback(error);
          }
        });
        return;
      }

      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    } catch (error) {
      rejectCallback(error);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  const redirectUri = `http://127.0.0.1:${port}${callbackPath}`;
  const timeout = setTimeout(() => {
    rejectCallback(new Error('pCloud sign-in timed out. Try connecting again.'));
    server.close();
  }, 5 * 60 * 1000);
  timeout.unref?.();

  return {
    redirectUri,
    async wait() {
      try {
        return await callbackPromise;
      } finally {
        clearTimeout(timeout);
        server.close();
      }
    },
    close() {
      clearTimeout(timeout);
      server.close();
    }
  };
}

async function connectGoogle(config) {
  if (!config.clientId) {
    throw new Error('Google Drive is not configured in this build. Add the publisher OAuth client ID first.');
  }

  const receiver = await createLoopbackReceiver({ redirectHost: '127.0.0.1', callbackPath: '/' });
  const state = crypto.randomBytes(24).toString('hex');
  const { verifier, challenge } = createPkce();

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: receiver.redirectUri,
    response_type: 'code',
    scope: [
      'openid',
      'email',
      'profile',
      'https://www.googleapis.com/auth/drive.file'
    ].join(' '),
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  }).toString();

  await shell.openExternal(authUrl.toString());
  const callback = await receiver.wait();
  if (callback.searchParams.get('state') !== state) {
    throw new Error('Google sign-in validation failed. Please try again.');
  }
  const callbackError = callback.searchParams.get('error');
  if (callbackError) {
    throw new Error(callback.searchParams.get('error_description') || callbackError);
  }
  const code = callback.searchParams.get('code');
  if (!code) throw new Error('Google did not return an authorization code.');

  const token = await fetchJson('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody({
      client_id: config.clientId,
      client_secret: config.clientSecret || undefined,
      code,
      code_verifier: verifier,
      redirect_uri: receiver.redirectUri,
      grant_type: 'authorization_code'
    })
  });

  if (!token.refresh_token) {
    throw new Error('Google did not return a background refresh token. Remove the app from your Google Account permissions and connect again.');
  }

  const profile = await fetchJson('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${token.access_token}` }
  });

  return {
    token: {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: Date.now() + Math.max(60, Number(token.expires_in || 3600)) * 1000
    },
    account: {
      name: profile.name || profile.email || 'Google Drive account',
      email: profile.email || ''
    }
  };
}

async function connectMicrosoft(config) {
  if (!config.clientId) {
    throw new Error('OneDrive is not configured in this build. Add the publisher Microsoft client ID first.');
  }

  const receiver = await createLoopbackReceiver({ redirectHost: 'localhost', callbackPath: '/' });
  const state = crypto.randomBytes(24).toString('hex');
  const { verifier, challenge } = createPkce();
  const scope = 'openid profile email offline_access User.Read Files.ReadWrite.AppFolder';

  const authUrl = new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  authUrl.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: receiver.redirectUri,
    response_type: 'code',
    response_mode: 'query',
    scope,
    prompt: 'select_account',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  }).toString();

  await shell.openExternal(authUrl.toString());
  const callback = await receiver.wait();
  if (callback.searchParams.get('state') !== state) {
    throw new Error('Microsoft sign-in validation failed. Please try again.');
  }
  const callbackError = callback.searchParams.get('error');
  if (callbackError) {
    throw new Error(callback.searchParams.get('error_description') || callbackError);
  }
  const code = callback.searchParams.get('code');
  if (!code) throw new Error('Microsoft did not return an authorization code.');

  const token = await fetchJson('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody({
      client_id: config.clientId,
      code,
      code_verifier: verifier,
      redirect_uri: receiver.redirectUri,
      grant_type: 'authorization_code',
      scope
    })
  });

  if (!token.refresh_token) {
    throw new Error('Microsoft did not return a background refresh token. Disconnect the account and connect again.');
  }

  const profile = await fetchJson('https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName', {
    headers: { Authorization: `Bearer ${token.access_token}` }
  });

  return {
    token: {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: Date.now() + Math.max(60, Number(token.expires_in || 3600)) * 1000
    },
    account: {
      name: profile.displayName || profile.mail || profile.userPrincipalName || 'OneDrive account',
      email: profile.mail || profile.userPrincipalName || ''
    }
  };
}


async function connectDropbox(config) {
  if (!config.clientId) {
    throw new Error('Dropbox is not configured in this build. Add the publisher Dropbox app key first.');
  }

  const receiver = await createLoopbackReceiver({
    redirectHost: '127.0.0.1',
    callbackPath: '/oauth/dropbox',
    port: 53682
  });
  const state = crypto.randomBytes(24).toString('hex');
  const { verifier, challenge } = createPkce();
  const redirectUri = receiver.redirectUri;
  const scope = 'account_info.read files.metadata.read files.content.read files.content.write';

  const authUrl = new URL('https://www.dropbox.com/oauth2/authorize');
  authUrl.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    token_access_type: 'offline',
    scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  }).toString();

  await shell.openExternal(authUrl.toString());
  const callback = await receiver.wait();
  if (callback.searchParams.get('state') !== state) {
    throw new Error('Dropbox sign-in validation failed. Please try again.');
  }
  const callbackError = callback.searchParams.get('error');
  if (callbackError) {
    throw new Error(callback.searchParams.get('error_description') || callbackError);
  }
  const code = callback.searchParams.get('code');
  if (!code) throw new Error('Dropbox did not return an authorization code.');

  const token = await fetchJson('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody({
      client_id: config.clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    })
  });

  if (!token.refresh_token) {
    throw new Error('Dropbox did not return a background refresh token. Disconnect the account and connect again.');
  }

  const profile = await fetchJson('https://api.dropboxapi.com/2/users/get_current_account', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'Content-Type': 'application/json'
    },
    body: 'null'
  });

  return {
    token: {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: Date.now() + Math.max(60, Number(token.expires_in || 14400)) * 1000
    },
    account: {
      name: profile.name?.display_name || profile.email || 'Dropbox account',
      email: profile.email || ''
    }
  };
}

async function connectPCloud(config) {
  if (!config.clientId) {
    throw new Error('pCloud is not configured in this build. Add the publisher pCloud client ID first.');
  }

  const receiver = await createFragmentLoopbackReceiver({
    callbackPath: '/oauth/pcloud',
    port: 53683
  });
  const state = crypto.randomBytes(24).toString('hex');
  const authUrl = new URL('https://my.pcloud.com/oauth2/authorize');
  authUrl.search = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'token',
    redirect_uri: receiver.redirectUri,
    state
  }).toString();

  await shell.openExternal(authUrl.toString());
  const callback = await receiver.wait();
  if (callback.state !== state) throw new Error('pCloud sign-in validation failed. Please try again.');
  if (callback.error) throw new Error(callback.error_description || callback.error);
  if (!callback.access_token) throw new Error('pCloud did not return an access token.');

  const apiHost = ['api.pcloud.com', 'eapi.pcloud.com'].includes(callback.hostname)
    ? callback.hostname
    : callback.locationid === '2' ? 'eapi.pcloud.com' : 'api.pcloud.com';
  const profile = await fetchJson(`https://${apiHost}/userinfo`, {
    headers: { Authorization: `Bearer ${callback.access_token}` }
  });
  if (Number(profile?.result || 0) !== 0) {
    throw new Error(profile?.error || 'pCloud could not read the connected account.');
  }

  return {
    token: {
      accessToken: callback.access_token,
      apiHost,
      expiresAt: Date.now() + (10 * 365 * 24 * 60 * 60 * 1000)
    },
    account: {
      name: profile.email || profile.mail || `pCloud user ${profile.userid || ''}`.trim(),
      email: profile.email || profile.mail || ''
    }
  };
}

async function connectCloudProvider({ provider, store }) {
  if (activeFlow) throw new Error('Another cloud sign-in is already in progress.');
  activeFlow = true;
  try {
    const apps = getOAuthApps(runtimeOAuthConfiguration(store.get()));
    const result = provider === 'google-drive'
      ? await connectGoogle(apps.google)
      : provider === 'onedrive'
        ? await connectMicrosoft(apps.microsoft)
        : provider === 'dropbox'
          ? await connectDropbox(apps.dropbox)
          : provider === 'pcloud'
            ? await connectPCloud(apps.pcloud)
            : null;

    if (!result) throw new Error('Unsupported cloud provider.');

    const settingsKey = provider === 'google-drive' ? 'googleDrive' : provider === 'onedrive' ? 'oneDrive' : provider === 'dropbox' ? 'dropbox' : 'pCloud';
    store.update((state) => {
      state.settings[settingsKey].tokenEncrypted = encryptJson(result.token);
      state.settings[settingsKey].accountName = result.account.name;
      state.settings[settingsKey].accountEmail = result.account.email;
    });

    return {
      ok: true,
      provider,
      accountName: result.account.name,
      accountEmail: result.account.email,
      message: `${provider === 'google-drive' ? 'Google Drive' : provider === 'onedrive' ? 'OneDrive' : provider === 'dropbox' ? 'Dropbox' : 'pCloud'} connected as ${result.account.email || result.account.name}.`
    };
  } finally {
    activeFlow = false;
  }
}

function disconnectCloudProvider({ provider, store }) {
  const settingsKey = provider === 'google-drive'
    ? 'googleDrive'
    : provider === 'onedrive'
      ? 'oneDrive'
      : provider === 'dropbox'
        ? 'dropbox'
        : provider === 'pcloud'
          ? 'pCloud'
          : null;
  if (!settingsKey) throw new Error('Unsupported cloud provider.');

  store.update((state) => {
    state.settings[settingsKey].tokenEncrypted = '';
    state.settings[settingsKey].accountName = '';
    state.settings[settingsKey].accountEmail = '';
    if (state.settings.provider === provider) state.settings.provider = 'local';
  });
  return { ok: true, provider };
}

module.exports = { connectCloudProvider, disconnectCloudProvider };
