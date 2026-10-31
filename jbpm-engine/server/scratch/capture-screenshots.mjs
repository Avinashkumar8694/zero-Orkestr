import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHROME_PORT = 9333;

async function loginAndGetToken() {
  const res = await fetch('http://localhost:4000/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin-change-me' }),
  });
  return res.json();
}

async function waitForChrome(port, maxTries = 30) {
  for (let i = 0; i < maxTries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        const data = await res.json();
        return data.webSocketDebuggerUrl;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Chrome failed to start on port ${port}`);
}

async function run() {
  const { token, user } = await loginAndGetToken();
  console.log('Got auth token for user:', user.id);

  const profileDir = `/tmp/chrome-profile-${Date.now()}`;
  fs.mkdirSync(profileDir, { recursive: true });

  console.log('Spawning headless Chrome...');
  const chromeProc = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${CHROME_PORT}`,
    '--disable-gpu',
    '--window-size=1440,900',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ], { stdio: 'ignore' });

  try {
    const wsUrl = await waitForChrome(CHROME_PORT);
    console.log('Connected to Chrome CDP:', wsUrl);

    // Create a new target/page
    const newTabRes = await fetch(`http://127.0.0.1:${CHROME_PORT}/json/new`, { method: 'PUT' });
    const tabData = await newTabRes.json();
    const pageWsUrl = tabData.webSocketDebuggerUrl;

    const ws = new WebSocket(pageWsUrl);
    let id = 1;
    const callbacks = new Map();

    function send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const msgId = id++;
        callbacks.set(msgId, { resolve, reject });
        ws.send(JSON.stringify({ id: msgId, method, params }));
      });
    }

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && callbacks.has(msg.id)) {
        const { resolve, reject } = callbacks.get(msg.id);
        callbacks.delete(msg.id);
        if (msg.error) reject(msg.error);
        else resolve(msg.result);
      }
    });

    await new Promise((r) => ws.on('open', r));
    console.log('Page WebSocket connected!');

    // High DPI viewport
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 2,
      mobile: false,
    });

    await send('Page.enable');
    await send('Runtime.enable');

    // 1. Initial navigation to seed tokens in localStorage & sessionStorage
    console.log('Navigating to http://localhost:4200/login...');
    await send('Page.navigate', { url: 'http://localhost:4200/login' });
    await new Promise((r) => setTimeout(r, 2000));

    await send('Runtime.evaluate', {
      expression: `
        localStorage.setItem('jbpm.token', ${JSON.stringify(token)});
        sessionStorage.setItem('jbpm.token', ${JSON.stringify(token)});
        localStorage.setItem('zero.workspace.v1', JSON.stringify({ sub: ${JSON.stringify(user.id)}, id: 'default' }));
        localStorage.setItem('fabpay-theme', 'dark');
      `,
    });
    console.log('Auth session injected.');

    const screenshotsDir = path.resolve(process.cwd(), '../app/src/assets/screenshots');
    const artifactDir = '/Users/avinashkumargupta/.gemini/antigravity/brain/ddbd3ed9-5aab-43fb-92a2-b53e410f5a3e';
    fs.mkdirSync(screenshotsDir, { recursive: true });

    const routes = [
      { name: 'feature_bpmn_designer', url: 'http://localhost:4200/projects/01M68BVFXHA4M4K6/processes/customer-kyc-identity-verification.process', waitMs: 3500 },
      { name: 'feature_home', url: 'http://localhost:4200/home', waitMs: 2000 },
      { name: 'feature_deployments', url: 'http://localhost:4200/deployments', waitMs: 2000 },
      { name: 'feature_instances', url: 'http://localhost:4200/instances', waitMs: 2000 },
      { name: 'feature_instance_detail', url: 'http://localhost:4200/instances/inst_ord_001', waitMs: 2500 },
      { name: 'feature_tasks_inbox', url: 'http://localhost:4200/tasks', waitMs: 2000 },
      { name: 'feature_task_detail', url: 'http://localhost:4200/tasks/task_001', waitMs: 2000 },
      { name: 'feature_decision_tables', url: 'http://localhost:4200/projects/01M68BVFXHA4M4K6/assets', waitMs: 2000 },
      { name: 'feature_execution_errors', url: 'http://localhost:4200/errors', waitMs: 2000 },
      { name: 'feature_workflow_analytics', url: 'http://localhost:4200/workflow-analytics', waitMs: 2500 },
      { name: 'feature_reports', url: 'http://localhost:4200/reports', waitMs: 2000 },
      { name: 'feature_audit_log', url: 'http://localhost:4200/audit', waitMs: 2000 },
      { name: 'feature_workspace_settings', url: 'http://localhost:4200/settings', waitMs: 2000 },
    ];

    for (const item of routes) {
      console.log(`Navigating to ${item.name} (${item.url})...`);
      await send('Page.navigate', { url: item.url });
      await new Promise((r) => setTimeout(r, item.waitMs));

      const shotRes = await send('Page.captureScreenshot', {
        format: 'png',
        quality: 100,
        captureBeyondViewport: false,
      });

      const buf = Buffer.from(shotRes.data, 'base64');
      const assetPath = path.join(screenshotsDir, `${item.name}.png`);
      const artPath = path.join(artifactDir, `${item.name}.png`);

      fs.writeFileSync(assetPath, buf);
      fs.writeFileSync(artPath, buf);
      console.log(`Saved screenshot: ${item.name}.png (${(buf.length / 1024).toFixed(1)} KB)`);
    }

    console.log('All screenshots captured successfully!');
    ws.close();
  } finally {
    chromeProc.kill();
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
  }
}

run().catch(console.error);
