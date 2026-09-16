const express = require('express');
const { chromium } = require('playwright');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '2mb' }));
const PORT = Number(process.env.PORT || 3000);
const SECRET = String(process.env.THEORY_SYNC_SECRET || '');
const BASE_URL = String(process.env.HUELMS_BASE_URL || 'https://vietmy.huelms.com').replace(/\/$/, '');
const DEFAULT_PASSWORD = String(process.env.HUELMS_DEFAULT_PASSWORD || '');
const jobs = new Map();

function assertSecret(value) {
  if (!SECRET || !value || value !== SECRET) throw new Error('UNAUTHORIZED');
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function score(v) { const m = String(v || '').replace(',', '.').match(/-?\d+(?:\.\d+)?/); return m ? Number(m[0]) : 0; }
function norm(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim(); }

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const loc = page.locator(selector).first();
    try { if (await loc.count() && await loc.isVisible()) return loc; } catch (_) { }
  }
  return null;
}

async function login(page, username, password) {
  console.log(`[LOGIN] Bắt đầu: ${String(username).slice(0, 4)}******`);

  // 1. Mở HueLMS
  await page.goto(BASE_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  await page.waitForTimeout(1500);

  console.log('[LOGIN] URL ban đầu:', page.url());
  console.log('[LOGIN] Title:', await page.title().catch(() => ''));

  // 2. Nếu chưa ở trang login, tìm link login hoặc thử /user/login
  let passCount = await page.locator('input[type="password"]').count();

  if (!passCount) {
    const loginLink = await firstVisible(page, [
      'a[href*="/user/login"]',
      'a:has-text("Đăng nhập")',
      'button:has-text("Đăng nhập")'
    ]);

    if (loginLink) {
      console.log('[LOGIN] Tìm thấy liên kết đăng nhập.');
      await loginLink.click().catch(() => { });
      await page.waitForTimeout(1500);
    }
  }

  // 3. Nếu vẫn chưa có form thì mở trực tiếp /user/login
  passCount = await page.locator('input[type="password"]').count();

  if (!passCount) {
    console.log('[LOGIN] Thử mở trực tiếp /user/login');

    await page.goto(BASE_URL + '/user/login', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await page.waitForTimeout(1500);
  }

  console.log('[LOGIN] URL form:', page.url());

  // 4. Tìm username
  const userInput = await firstVisible(page, [
    'input[placeholder*="Tên đăng nhập" i]',
    'input[placeholder*="tên đăng nhập" i]',
    'input[name="username"]',
    'input[name="userName"]',
    'input[name="account"]',
    'input[type="text"]'
  ]);

  // 5. Tìm password
  const passInput = await firstVisible(page, [
    'input[placeholder*="Nhập mật khẩu" i]',
    'input[placeholder*="mật khẩu" i]',
    'input[name="password"]',
    'input[type="password"]'
  ]);

  if (!userInput || !passInput) {
    const inputs = await page.locator('input').evaluateAll(els =>
      els.map(el => ({
        type: el.type,
        name: el.name,
        id: el.id,
        placeholder: el.placeholder
      }))
    ).catch(() => []);

    console.log('[LOGIN] Inputs tìm được:', JSON.stringify(inputs));

    throw new Error(
      'Không tìm thấy ô tài khoản/mật khẩu HueLMS. URL: ' + page.url()
    );
  }

  console.log('[LOGIN] Đã tìm thấy form đăng nhập.');

  // 6. Điền CCCD + mật khẩu
  await userInput.fill(String(username));
  await passInput.fill(String(password));

  // 7. Tìm nút Đăng nhập
  const button = await firstVisible(page, [
    'button:has-text("Đăng nhập")',
    'button:has-text("ĐĂNG NHẬP")',
    'button[type="submit"]',
    'input[type="submit"]'
  ]);

  if (!button) {
    throw new Error('Không tìm thấy nút Đăng nhập HueLMS.');
  }

  console.log('[LOGIN] Bấm Đăng nhập...');

  await button.click();

  // HueLMS có thể chuyển trang bằng JS
  await page.waitForTimeout(2500);

  console.log('[LOGIN] URL sau đăng nhập:', page.url());
  console.log('[LOGIN] Title sau đăng nhập:', await page.title().catch(() => ''));

  const body = norm(
    await page.locator('body').innerText().catch(() => '')
  );

  if (
    body.includes('sai mat khau') ||
    body.includes('mat khau khong dung') ||
    body.includes('tai khoan khong dung') ||
    body.includes('dang nhap that bai')
  ) {
    throw new Error('Sai tài khoản hoặc mật khẩu HueLMS.');
  }

  // Nếu vẫn còn form password thì khả năng đăng nhập chưa thành công
  const stillLogin =
    await page.locator('input[type="password"]').count().catch(() => 0);

  if (stillLogin) {
    throw new Error(
      'HueLMS vẫn ở trang đăng nhập sau khi gửi tài khoản. URL: ' +
      page.url()
    );
  }

  console.log('[LOGIN] Đăng nhập thành công.');
}

async function openProgressPage(page) {
  if ((await page.locator('text=Bảng điểm khoá học').count()) || (await page.locator('text=Bảng điểm khóa học').count())) return;
  const direct = page.locator('a[href*="/student/ep/"]').first();
  if (await direct.count()) {
    await direct.click(); await page.waitForLoadState('domcontentloaded').catch(() => { }); return;
  }
  const candidates = [
    'a:has-text("Chương trình đào tạo")', 'a:has-text("Khóa học")', 'a:has-text("Khoá học")',
    'a:has-text("Tiến độ")', 'a:has-text("Kết quả")', 'button:has-text("Chi tiết")'
  ];
  for (const selector of candidates) {
    const loc = page.locator(selector).first();
    if (await loc.count()) { try { await loc.click(); await page.waitForTimeout(900); } catch (_) { } const next = page.locator('a[href*="/student/ep/"]').first(); if (await next.count()) { await next.click(); await page.waitForLoadState('domcontentloaded').catch(() => { }); return; } }
  }
  if (!((await page.locator('text=Bảng điểm khoá học').count()) || (await page.locator('text=Bảng điểm khóa học').count()))) {
    throw new Error('Không tìm thấy trang Bảng điểm khóa học. Cần hiệu chỉnh đường dẫn HueLMS một lần.');
  }
}

async function scrapeScores(page) {
  const rows = await page.locator('table tr').evaluateAll(trs => trs.map(tr => Array.from(tr.querySelectorAll('th,td')).map(td => (td.innerText || '').trim()).filter(Boolean)));
  const scores = { ethics: 0, drivingTechnique: 0, vehicleStructure: 0, trafficLaw: 0, pl1: 0, pl2: 0, pl3: 0, simulation: 0 };
  for (const cells of rows) {
    if (!cells.length) continue;
    const label = norm(cells[0]);
    const value = score(cells[cells.length - 1]);
    if (label.includes('dao duc') && label.includes('pccc')) scores.ethics = value;
    else if (label.includes('ky thuat lai xe')) scores.drivingTechnique = value;
    else if (label.includes('cau tao') && label.includes('sua chua')) scores.vehicleStructure = value;
    else if (label.includes('phap luat gtdb')) scores.trafficLaw = value;
    else if (label.startsWith('pl1')) scores.pl1 = value;
    else if (label.startsWith('pl2')) scores.pl2 = value;
    else if (label.startsWith('pl3')) scores.pl3 = value;
    else if (label.includes('mo phong')) scores.simulation = value;
  }
  return scores;
}
function deriveStatus(scores) { const vals = Object.values(scores); if (vals.length && vals.every(v => Number(v) >= 100)) return 'Hoàn thành'; if (vals.some(v => Number(v) > 0)) return 'Đang học'; return 'Chưa học'; }

async function syncStudent(browser, student) {
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, locale: 'vi-VN' });
  const page = await context.newPage();
  try {
    await login(page, String(student.cccd || '').trim(), DEFAULT_PASSWORD);
    await openProgressPage(page);
    const scores = await scrapeScores(page);
    return { ...student, scores, status: deriveStatus(scores), error: '' };
  } catch (e) {
    return { ...student, scores: {}, status: 'Lỗi đồng bộ', error: e && e.message ? e.message : String(e) };
  } finally { await context.close(); }
}

async function callback(url, jobId, result) {
  const body = new URLSearchParams();
  body.set('data', JSON.stringify({ action: 'theory.workerCallback', secret: SECRET, jobId, result }));
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body });
  if (!res.ok) throw new Error('Callback HTTP ' + res.status);
}

async function runJob(job) {
  let browser;
  try {
    if (!DEFAULT_PASSWORD) throw new Error('Thiếu HUELMS_DEFAULT_PASSWORD trên worker.');
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    job.status = 'running';
    for (let i = 0; i < job.students.length; i++) {
      const result = await syncStudent(browser, job.students[i]);
      await callback(job.callbackUrl, job.id, result).catch(err => { result.callbackError = err.message; });
      job.processed = i + 1;
      if (result.error) job.errors++;
      await sleep(job.delayMs);
    }
    job.status = 'done';
  } catch (e) { job.status = 'failed'; job.error = e.message || String(e); }
  finally { if (browser) await browser.close().catch(() => { }); job.finishedAt = new Date().toISOString(); }
}

app.get('/health', (req, res) => res.json({ ok: true, service: 'huelms-sync' }));
app.post('/jobs', (req, res) => {
  try {
    assertSecret(req.body.secret);
    if (!req.body.callbackUrl) return res.status(400).json({ error: 'Thiếu callbackUrl' });
    const students = Array.isArray(req.body.students) ? req.body.students.filter(s => s && s.cccd) : [];
    if (!students.length) return res.status(400).json({ error: 'Không có học viên hợp lệ' });
    if (students.length > 20) return res.status(400).json({ error: 'Chế độ bán tự động hỗ trợ tối đa 20 học viên/lần' });
    const id = crypto.randomUUID();
    const delayMs = Math.max(1200, Math.min(5000, Number(req.body.delayMs || 1800)));
    const job = { id, status: 'queued', processed: 0, errors: 0, total: students.length, students, callbackUrl: req.body.callbackUrl, delayMs, createdAt: new Date().toISOString() };
    jobs.set(id, job);
    setImmediate(() => runJob(job));
    res.status(202).json({ jobId: id, total: students.length, status: 'queued' });
  } catch (e) { res.status(401).json({ error: e.message || String(e) }); }
});
app.get('/jobs/:id', (req, res) => {
  try {
    assertSecret(String(req.get('X-Theory-Secret') || ''));
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Không tìm thấy job' });
    res.json({ id: job.id, status: job.status, processed: job.processed, total: job.total, errors: job.errors, error: job.error || '', createdAt: job.createdAt, finishedAt: job.finishedAt || '' });
  } catch (e) { res.status(401).json({ error: e.message || String(e) }); }
});

app.listen(PORT, () => console.log(`HueLMS sync worker listening on :${PORT}`));
