const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const url = require('url');

const sessions = new Map();

function createSession({ host, port = 22, username, password, identityFile }) {
  const id = crypto.randomUUID();
  sessions.set(id, {
    id,
    host,
    port: Number(port) || 22,
    username,
    password: password || '',
    identityFile: identityFile || '',
    createdAt: Date.now(),
    terminal: null,
  });
  return sessions.get(id);
}

function removeSession(id) {
  const session = sessions.get(id);
  if (!session) return;
  if (session.terminal && session.terminal.process) {
    session.terminal.process.kill('SIGKILL');
  }
  sessions.delete(id);
}

function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function serveStatic(req, res) {
  const parsed = url.parse(req.url);
  let filePath = path.join(__dirname, 'public', parsed.pathname);
  if (parsed.pathname === '/') {
    filePath = path.join(__dirname, 'public', 'index.html');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath);
    const mime = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
    }[ext] || 'text/plain';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 5 * 1024 * 1024) {
        reject(new Error('Payload too large'));
        req.connection.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
  });
}

function buildSshCommand(session) {
  const baseArgs = [
    '-p', session.port,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
  ];
  if (session.identityFile) {
    baseArgs.push('-i', session.identityFile);
  }
  baseArgs.push(`${session.username}@${session.host}`);
  return baseArgs;
}

function executeRemote(session, remoteCommand) {
  return new Promise((resolve, reject) => {
    const args = buildSshCommand(session);
    args.push(remoteCommand);
    const child = spawn('ssh', args, { env: { ...process.env, LC_ALL: 'C' } });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', data => {
      stdout += data.toString();
    });

    child.stderr.on('data', data => {
      const text = data.toString();
      stderr += text;
      if (session.password && text.toLowerCase().includes('password')) {
        child.stdin.write(`${session.password}\n`);
      }
    });

    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `Command failed with code ${code}`));
    });
  });
}

function handleMetrics(session) {
  const command = `
    set -e; \
    MEM=$(cat /proc/meminfo | awk "NR==1{total=$2} NR==2{free=$2} NR==3{avail=$2} END{used=total-avail; printf \"{\\\"total\\\":%s,\\\"free\\\":%s,\\\"available\\\":%s,\\\"used\\\":%s}\", total*1024, free*1024, avail*1024, used*1024}"); \
    CPU=$(cat /proc/loadavg | awk "{printf \"{\\\"load1\\\":%s,\\\"load5\\\":%s,\\\"load15\\\":%s}\", $1,$2,$3}"); \
    DISK=$(df -B1 --output=target,size,used,avail | tail -n +2 | awk 'BEGIN{print "["}{printf "%s{\\\"mount\\\":\\\""$1"\\\",\\\"size\\\":"$2",\\\"used\\\":"$3",\\\"available\\\":"$4"}", NR==1?"":","}END{print "]"}'); \
    echo "{\"memory\":$MEM,\"cpu\":$CPU,\"storage\":$DISK}";
  `;
  return executeRemote(session, command);
}

function sanitizeRemotePath(input) {
  if (!input) return '.';
  return input.replace(/'/g, "'\\''");
}

async function listDirectory(session, dirPath) {
  const safePath = sanitizeRemotePath(dirPath);
  const command = `cd '${safePath}' && ls -la`;
  const output = await executeRemote(session, command);
  return output;
}

async function downloadFile(session, filePath) {
  const safePath = sanitizeRemotePath(filePath);
  const command = `base64 -w0 '${safePath}'`;
  return executeRemote(session, command);
}

async function uploadFile(session, targetPath, contentBase64) {
  const safePath = sanitizeRemotePath(targetPath);
  const payload = Buffer.from(contentBase64 || '', 'base64').toString('utf8');
  const command = `cat > '${safePath}' <<'EOF'\n${payload}\nEOF`;
  return executeRemote(session, command);
}

function handleApi(req, res) {
  const parsed = url.parse(req.url, true);
  const { pathname } = parsed;

  if (req.method === 'POST' && pathname === '/api/session') {
    return parseBody(req)
      .then(body => {
        const required = ['host', 'username'];
        for (const field of required) {
          if (!body[field]) {
            jsonResponse(res, 400, { error: `${field} is required` });
            return;
          }
        }
        const session = createSession(body);
        jsonResponse(res, 201, { sessionId: session.id });
      })
      .catch(err => jsonResponse(res, 400, { error: err.message }));
  }

  if (req.method === 'DELETE' && pathname.startsWith('/api/session/')) {
    const id = pathname.split('/').pop();
    removeSession(id);
    jsonResponse(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/api/session/') && pathname.endsWith('/metrics')) {
    const id = pathname.split('/')[3];
    const session = sessions.get(id);
    if (!session) return jsonResponse(res, 404, { error: 'Unknown session' });
    handleMetrics(session)
      .then(output => jsonResponse(res, 200, { raw: output }))
      .catch(err => jsonResponse(res, 500, { error: err.message }));
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/api/session/') && pathname.endsWith('/list')) {
    const id = pathname.split('/')[3];
    const session = sessions.get(id);
    if (!session) return jsonResponse(res, 404, { error: 'Unknown session' });
    listDirectory(session, parsed.query.path || '.')
      .then(output => jsonResponse(res, 200, { output }))
      .catch(err => jsonResponse(res, 500, { error: err.message }));
    return;
  }

  if (req.method === 'POST' && pathname.startsWith('/api/session/') && pathname.endsWith('/download')) {
    const id = pathname.split('/')[3];
    const session = sessions.get(id);
    if (!session) return jsonResponse(res, 404, { error: 'Unknown session' });
    parseBody(req)
      .then(body => downloadFile(session, body.path))
      .then(base64 => jsonResponse(res, 200, { base64 }))
      .catch(err => jsonResponse(res, 500, { error: err.message }));
    return;
  }

  if (req.method === 'POST' && pathname.startsWith('/api/session/') && pathname.endsWith('/upload')) {
    const id = pathname.split('/')[3];
    const session = sessions.get(id);
    if (!session) return jsonResponse(res, 404, { error: 'Unknown session' });
    parseBody(req)
      .then(body => {
        if (!body.path || !body.base64) throw new Error('path and base64 required');
        return uploadFile(session, body.path, body.base64);
      })
      .then(() => jsonResponse(res, 200, { ok: true }))
      .catch(err => jsonResponse(res, 500, { error: err.message }));
    return;
  }

  serveStatic(req, res);
}

function websocketAcceptKey(key) {
  return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

function sendWebSocket(socket, data) {
  const payload = Buffer.from(data);
  let header = null;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeUInt32BE(Math.floor(payload.length / 2 ** 32), 2);
    header.writeUInt32BE(payload.length >>> 0, 6);
  }
  socket.write(Buffer.concat([header, payload]));
}

function parseWebSocketFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const byte1 = buffer[offset];
    const byte2 = buffer[offset + 1];
    const opcode = byte1 & 0x0f;
    const masked = (byte2 & 0x80) === 0x80;
    let length = byte2 & 0x7f;
    let headerSize = 2;

    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = buffer.readUInt16BE(offset + 2);
      headerSize += 2;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break;
      const high = buffer.readUInt32BE(offset + 2);
      const low = buffer.readUInt32BE(offset + 6);
      length = high * 2 ** 32 + low;
      headerSize += 8;
    }

    const mask = masked ? buffer.slice(offset + headerSize, offset + headerSize + 4) : null;
    if (masked) headerSize += 4;
    if (offset + headerSize + length > buffer.length) break;

    let payload = buffer.slice(offset + headerSize, offset + headerSize + length);
    if (masked && mask) {
      payload = Buffer.from(payload.map((byte, idx) => byte ^ mask[idx % 4]));
    }

    if (opcode === 0x1) {
      messages.push(payload.toString());
    }
    offset += headerSize + length;
  }
  return messages;
}

function attachTerminal(socket, sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    sendWebSocket(socket, 'Invalid session');
    socket.end();
    return;
  }

  const args = buildSshCommand(session);
  args.unshift('-tt');
  const proc = spawn('ssh', args, { env: { ...process.env, LC_ALL: 'C' } });
  session.terminal = { process: proc, socket };

  proc.stdout.on('data', data => sendWebSocket(socket, data));
  proc.stderr.on('data', data => {
    const text = data.toString();
    if (session.password && text.toLowerCase().includes('password')) {
      proc.stdin.write(`${session.password}\n`);
    } else {
      sendWebSocket(socket, data);
    }
  });

  proc.on('close', code => {
    sendWebSocket(socket, `\n[connection closed with code ${code}]`);
    socket.end();
  });

  socket.on('data', chunk => {
    const messages = parseWebSocketFrames(chunk);
    messages.forEach(msg => {
      proc.stdin.write(msg);
    });
  });

  socket.on('end', () => {
    proc.kill('SIGKILL');
  });
}

const server = http.createServer(handleApi);

server.on('upgrade', (req, socket) => {
  const parsed = url.parse(req.url, true);
  if (parsed.pathname !== '/terminal') {
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const acceptKey = websocketAcceptKey(key);
  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`,
  ];
  socket.write(headers.concat('\r\n').join('\r\n'));
  socket.on('data', data => {
    const messages = parseWebSocketFrames(data);
    messages.forEach(message => {
      if (message.startsWith('SESSION ')) {
        const sessionId = message.replace('SESSION ', '').trim();
        attachTerminal(socket, sessionId);
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
