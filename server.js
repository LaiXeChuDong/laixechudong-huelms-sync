const express = require('express');
const { chromium } = require('playwright');
const crypto = require('crypto');

const app = express();

app.use(express.json({ limit: '2mb' }));

// ============================================================
// CONFIG
// ============================================================

const PORT = Number(process.env.PORT || 3000);

const SECRET = String(
  process.env.THEORY_SYNC_SECRET || ''
).trim();

const BASE_URL = String(
  process.env.HUELMS_BASE_URL ||
  'https://vietmy.huelms.com'
).replace(/\/+$/, '');

const DEFAULT_PASSWORD = String(
  process.env.HUELMS_DEFAULT_PASSWORD || ''
);

const jobs = new Map();

// ============================================================
// UTILITIES
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function maskUsername(value) {
  const text = String(value || '').trim();

  if (!text) return '';

  if (text.length <= 4) {
    return '*'.repeat(text.length);
  }

  return (
    text.slice(0, 4) +
    '*'.repeat(Math.max(4, text.length - 4))
  );
}

function norm(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parsePercent(value) {
  const text = String(value || '')
    .replace(/\u00a0/g, ' ')
    .trim();

  // Không cho phép bắt đầu match ở giữa một số như 76.6% -> 6%.
  const match = text.match(
    /(?:^|[^\d])([0-9]{1,3}(?:[.,][0-9]+)?)\s*%/
  );

  if (!match) {
    return null;
  }

  const number = Number(match[1].replace(',', '.'));

  if (!Number.isFinite(number)) {
    return null;
  }

  return Math.max(0, Math.min(100, number));
}

function assertSecret(value) {
  if (
    !SECRET ||
    !value ||
    String(value).trim() !== SECRET
  ) {
    throw new Error('UNAUTHORIZED');
  }
}

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    try {
      const locator =
        page.locator(selector).first();

      if (
        await locator.count() > 0 &&
        await locator
          .isVisible()
          .catch(() => false)
      ) {
        return locator;
      }
    } catch (_) { }
  }

  return null;
}

// ============================================================
// LOGIN
// ============================================================

async function login(page, username, password) {
  const masked = maskUsername(username);

  console.log(
    '==================================================='
  );

  console.log(
    `[LOGIN] Bắt đầu: ${masked}`
  );

  await page.goto(BASE_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  await page.waitForTimeout(1200);

  console.log(
    '[LOGIN] URL ban đầu:',
    page.url()
  );

  let userInput =
    await firstVisible(page, [
      'input[placeholder*="Tên đăng nhập" i]',
      'input[placeholder*="tài khoản" i]',
      'input[name="username"]',
      'input[name="userName"]',
      'input[name="login"]',
      'input[name="account"]',
      'input[id*="username" i]',
      'input[id*="login" i]',
      'input[type="text"]'
    ]);

  let passInput =
    await firstVisible(page, [
      'input[placeholder*="Nhập mật khẩu" i]',
      'input[placeholder*="mật khẩu" i]',
      'input[name="password"]',
      'input[name="Password"]',
      'input[id*="password" i]',
      'input[type="password"]'
    ]);

  if (!userInput || !passInput) {
    console.log(
      '[LOGIN] Thử mở trực tiếp /user/login'
    );

    await page.goto(
      `${BASE_URL}/user/login`,
      {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      }
    );

    await page.waitForTimeout(1200);

    console.log(
      '[LOGIN] URL form:',
      page.url()
    );

    userInput =
      await firstVisible(page, [
        'input[placeholder*="Tên đăng nhập" i]',
        'input[placeholder*="tài khoản" i]',
        'input[name="username"]',
        'input[name="userName"]',
        'input[name="login"]',
        'input[name="account"]',
        'input[id*="username" i]',
        'input[id*="login" i]',
        'input[type="text"]'
      ]);

    passInput =
      await firstVisible(page, [
        'input[placeholder*="Nhập mật khẩu" i]',
        'input[placeholder*="mật khẩu" i]',
        'input[name="password"]',
        'input[name="Password"]',
        'input[id*="password" i]',
        'input[type="password"]'
      ]);
  }

  if (!userInput || !passInput) {
    const inputs =
      await page
        .locator('input')
        .evaluateAll(elements =>
          elements.map(el => ({
            type: el.type || '',
            name: el.name || '',
            id: el.id || '',
            placeholder:
              el.placeholder || ''
          }))
        )
        .catch(() => []);

    console.log(
      '[LOGIN] Inputs tìm được:',
      JSON.stringify(inputs)
    );

    throw new Error(
      'Không tìm thấy form đăng nhập HueLMS. URL: ' +
      page.url()
    );
  }

  console.log(
    '[LOGIN] Đã tìm thấy form đăng nhập.'
  );

  await userInput.fill(
    String(username).trim()
  );

  await passInput.fill(
    String(password)
  );

  console.log(
    '[LOGIN] Đã nhập tài khoản và mật khẩu.'
  );

  const buttonSelectors = [
    'button:has-text("Đăng nhập")',
    'button:has-text("ĐĂNG NHẬP")',
    '[role="button"]:has-text("Đăng nhập")',
    'button[type="submit"]',
    'input[type="submit"]',
    'form button',
    'form [type="submit"]',
    '.btn:has-text("Đăng nhập")',
    'a:has-text("Đăng nhập")'
  ];

  let submitted = false;

  for (const selector of buttonSelectors) {
    try {
      const locator =
        page.locator(selector).first();

      if (
        await locator.count() > 0 &&
        await locator
          .isVisible()
          .catch(() => false)
      ) {
        console.log(
          '[LOGIN] Tìm thấy nút bằng selector:',
          selector
        );

        await locator.click({
          timeout: 10000
        });

        submitted = true;
        break;
      }
    } catch (_) { }
  }

  if (!submitted) {
    console.log(
      '[LOGIN] Không tìm thấy nút chuẩn, thử Enter...'
    );

    try {
      await passInput.press('Enter');
      submitted = true;
    } catch (_) { }
  }

  if (!submitted) {
    throw new Error(
      'Không thể gửi form đăng nhập HueLMS.'
    );
  }

  console.log(
    '[LOGIN] Đã gửi form đăng nhập.'
  );

  try {
    await page.waitForURL(
      url =>
        !url
          .toString()
          .includes('/user/login'),
      {
        timeout: 20000
      }
    );
  } catch (_) { }

  await page
    .waitForLoadState(
      'domcontentloaded'
    )
    .catch(() => { });

  console.log(
    '[LOGIN] URL sau bước đăng nhập:',
    page.url()
  );

  const visiblePassword =
    await page
      .locator(
        'input[type="password"]'
      )
      .first()
      .isVisible()
      .catch(() => false);

  if (visiblePassword) {
    throw new Error(
      'HueLMS vẫn ở trang đăng nhập. URL: ' +
      page.url()
    );
  }

  console.log(
    `[LOGIN] Đăng nhập thành công: ${masked}`
  );
}

// ============================================================
// FIND /student/ep/{ID}
// ============================================================

async function openProgressPage(page) {
  console.log('[PROGRESS] Tìm trang chi tiết tiến độ...');
  console.log('[PROGRESS] URL hiện tại:', page.url());

  // Nếu HueLMS đã tự chuyển đúng sang /student/ep/{ID} thì KHÔNG goto lại.
  // Việc goto lại trang chi tiết có thể làm phiên HueLMS ngắn đi hoặc bị logout.
  if (/\/student\/ep\/\d+\/?$/.test(page.url())) {
    console.log('[PROGRESS] Đã ở đúng trang chi tiết, giữ nguyên phiên:', page.url());
    return;
  }

  // HueLMS thường chuyển /student/ep -> /student/ep/{ID} bằng JavaScript.
  // Chỉ chờ ngắn để tránh giữ phiên quá lâu.
  try {
    await page.waitForURL(
      url => /\/student\/ep\/\d+\/?$/.test(url.toString()),
      { timeout: 7000 }
    );
  } catch (_) { }

  if (/\/student\/ep\/\d+\/?$/.test(page.url())) {
    console.log('[PROGRESS] HueLMS tự redirect thành công:', page.url());
    return;
  }

  let epId = null;

  // Tìm ID trong HTML/link/resource/storage nếu HueLMS chưa tự đổi URL.
  try {
    const html = await page.content();
    const match = html.match(/\/student\/ep\/(\d+)/);
    if (match) epId = match[1];
  } catch (_) { }

  if (!epId) {
    try {
      const hrefs = await page.locator('a[href]').evaluateAll(elements =>
        elements.map(el => el.href || '')
      );
      for (const href of hrefs) {
        const match = String(href).match(/\/student\/ep\/(\d+)/);
        if (match) {
          epId = match[1];
          break;
        }
      }
    } catch (_) { }
  }

  if (!epId) {
    try {
      const resources = await page.evaluate(() =>
        performance.getEntriesByType('resource').map(item => item.name)
      );
      for (const resource of resources) {
        const match = String(resource).match(/\/student\/ep\/(\d+)/);
        if (match) {
          epId = match[1];
          break;
        }
      }
    } catch (_) { }
  }

  if (!epId) {
    try {
      const storage = await page.evaluate(() => {
        const result = {};
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          result['local:' + key] = localStorage.getItem(key);
        }
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          result['session:' + key] = sessionStorage.getItem(key);
        }
        return result;
      });
      const match = JSON.stringify(storage).match(/\/student\/ep\/(\d+)/);
      if (match) epId = match[1];
    } catch (_) { }
  }

  // Kiểm tra lần cuối vì URL có thể đổi trong lúc đọc HTML/storage.
  const currentMatch = page.url().match(/\/student\/ep\/(\d+)/);
  if (currentMatch) {
    console.log('[PROGRESS] URL đã tự chuyển trong lúc dò:', page.url());
    return;
  }

  if (!epId) {
    throw new Error(
      'Đăng nhập thành công nhưng chưa xác định được ID trang tiến độ. URL hiện tại: ' +
      page.url()
    );
  }

  const target = `${BASE_URL}/student/ep/${epId}`;
  console.log('[PROGRESS] Chỉ khi chưa tự redirect mới mở trực tiếp:', target);

  await page.goto(target, {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });

  if (!/\/student\/ep\/\d+\/?$/.test(page.url())) {
    throw new Error(
      'Không vào được trang chi tiết tiến độ. URL hiện tại: ' + page.url()
    );
  }

  console.log('[PROGRESS] Vào trang chi tiết thành công:', page.url());
}

// ============================================================
// SCRAPE PROGRESS
// ============================================================

async function scrapeProgress(page) {
  console.log('[SCRAPE] Đọc tiến độ HueLMS...');
  console.log('[SCRAPE] URL:', page.url());

  if (/\/user\/login/i.test(page.url())) {
    throw new Error('HueLMS đã logout trước khi đọc được tiến độ.');
  }

  const scores = { ethics: 0, drivingTechnique: 0, vehicleStructure: 0, trafficLaw: 0, pl1: 0, pl2: 0, pl3: 0, simulation: 0 };
  const passed = { ethics: false, drivingTechnique: false, vehicleStructure: false, trafficLaw: false, pl1: false, pl2: false, pl3: false, simulation: false };
  const found = new Set();

  function identifyKey(label) {
    const name = norm(label);
    // Môn con phải nhận diện trước môn cha để tránh text của hàng cha chứa cả các hàng con.
    if (name.includes('phan 1') || /(^|\s)pl1(\s|$)/.test(name)) return 'pl1';
    if (name.includes('phan 2') || /(^|\s)pl2(\s|$)/.test(name)) return 'pl2';
    if (name.includes('phan 3') || /(^|\s)pl3(\s|$)/.test(name)) return 'pl3';
    if (name.includes('dao duc nguoi lai xe') || name.includes('dao duc') || name.includes('vhgt') || name.includes('pccc')) return 'ethics';
    if (name.includes('ky thuat lai xe')) return 'drivingTechnique';
    if (name.includes('cau tao sua chua') || (name.includes('cau tao') && name.includes('sua chua'))) return 'vehicleStructure';
    if (name.includes('phap luat giao thong duong bo') || name.includes('phap luat gtdb')) return 'trafficLaw';
    if (name.includes('mo phong cac tinh huong giao thong') || name.includes('mo phong')) return 'simulation';
    return null;
  }

  function record(key, percent, text) {
    const n = Number(percent);
    if (!key || !Number.isFinite(n) || n < 0 || n > 100) return false;
    scores[key] = n;
    passed[key] = /(^|\s)dat($|\s)/.test(norm(text));
    found.add(key);
    console.log(`[SCRAPE] ${key} = ${n}% | đạt=${passed[key]}`);
    return true;
  }

  // HueLMS có thể render bảng muộn. Thử tối đa 3 vòng; vòng sau reload trang chi tiết.
  for (let attempt = 1; attempt <= 3 && found.size < 8; attempt++) {
    if (attempt > 1) {
      console.log(`[SCRAPE] Thử lại lần ${attempt}/3...`);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { });
    }

    await page.waitForTimeout(attempt === 1 ? 2500 : 4000);

    // Chờ một trong các nhãn thật của bảng xuất hiện trong DOM hiển thị.
    await page.waitForFunction(() => {
      const t = (document.body && document.body.innerText || '').toLowerCase();
      return t.includes('kỹ thuật lái xe') || t.includes('ky thuat lai xe') ||
        t.includes('pháp luật giao thông') || t.includes('phap luat giao thong') ||
        t.includes('mô phỏng') || t.includes('mo phong');
    }, { timeout: 12000 }).catch(() => { });

    // Cách 1: đọc mọi TR ở tất cả frame.
    for (const frame of page.frames()) {
      let rows = [];
      try {
        rows = await frame.locator('tr').evaluateAll(elements => elements.map(tr => ({
          cells: Array.from(tr.querySelectorAll('th,td')).map(td => (td.innerText || td.textContent || '').replace(/\s+/g, ' ').trim()),
          text: (tr.innerText || tr.textContent || '').replace(/\s+/g, ' ').trim()
        })).filter(x => x.text));
      } catch (_) { }

      console.log(`[SCRAPE] attempt=${attempt} frame=${frame.url()} rows=${rows.length}`);
      for (const row of rows) {
        const key = identifyKey(row.text);
        if (!key || found.has(key)) continue;
        let percent = null;
        for (const cell of row.cells || []) {
          const p = parsePercent(cell);
          if (p !== null) { percent = p; break; }
        }
        if (percent === null) percent = parsePercent(row.text);
        if (percent !== null) record(key, percent, row.text);
      }
    }

    // Cách 2: không phụ thuộc table/tr. Tìm các element hiển thị có dấu % rồi đi ngược
    // lên ancestor gần nhất; cách này hoạt động cả khi HueLMS đổi table thành div/grid.
    if (found.size < 8) {
      for (const frame of page.frames()) {
        let blocks = [];
        try {
          blocks = await frame.evaluate(() => {
            const out = [];
            const all = Array.from(document.querySelectorAll('body *'));
            for (const el of all) {
              const own = (el.innerText || '').replace(/\s+/g, ' ').trim();
              if (!own || !/\d{1,3}(?:[.,]\d+)?\s*%/.test(own)) continue;
              // Bỏ container quá lớn; ưu tiên block nhỏ chứa tên môn + phần trăm.
              if (own.length > 700) continue;
              const r = el.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0) continue;
              out.push(own);
            }
            return Array.from(new Set(out)).sort((a, b) => a.length - b.length).slice(0, 300);
          });
        } catch (_) { }
        for (const text of blocks) {
          const key = identifyKey(text);
          if (!key || found.has(key)) continue;
          const p = parsePercent(text);
          if (p !== null) record(key, p, text);
        }
      }
    }

    // Cách 3: body.innerText fallback. Cắt từ nhãn hiện tại đến nhãn môn kế tiếp,
    // rồi lấy % đầu tiên. Không dùng đoạn greedy nên 76.6% không thể thành 6%.
    if (found.size < 8) {
      let pageText = '';
      for (const frame of page.frames()) {
        try {
          const t = await frame.locator('body').innerText({ timeout: 3000 });
          if (t) pageText += '\n' + t;
        } catch (_) {
          try {
            const t = await frame.evaluate(() => document.body ? (document.body.innerText || document.body.textContent || '') : '');
            if (t) pageText += '\n' + t;
          } catch (_) { }
        }
      }
      console.log('[SCRAPE] Độ dài body.innerText:', pageText.length);
      const compact = norm(pageText);
      const defs = [
        ['ethics', ['dao duc nguoi lai xe', 'dao duc']],
        ['drivingTechnique', ['ky thuat lai xe o to', 'ky thuat lai xe']],
        ['vehicleStructure', ['cau tao sua chua']],
        ['trafficLaw', ['phap luat giao thong duong bo', 'phap luat gtdb']],
        ['pl1', ['phan 1.', 'phan 1 ', 'pl1']],
        ['pl2', ['phan 2.', 'phan 2 ', 'pl2']],
        ['pl3', ['phan 3.', 'phan 3 ', 'pl3']],
        ['simulation', ['mo phong cac tinh huong giao thong', 'mo phong']]
      ];
      const positions = [];
      for (const [key, labels] of defs) {
        for (const label of labels) {
          const i = compact.indexOf(label);
          if (i >= 0) { positions.push({ key, i, label }); break; }
        }
      }
      positions.sort((a, b) => a.i - b.i);
      for (let i = 0; i < positions.length; i++) {
        const cur = positions[i];
        if (found.has(cur.key)) continue;
        const end = i + 1 < positions.length ? positions[i + 1].i : Math.min(compact.length, cur.i + 500);
        const segment = compact.slice(cur.i, Math.max(cur.i + 120, end));
        const p = parsePercent(segment);
        if (p !== null) record(cur.key, p, segment);
      }
    }

    console.log(`[SCRAPE] Sau attempt ${attempt}: ${found.size}/8`);
  }

  const requiredKeys = ['ethics', 'drivingTechnique', 'vehicleStructure', 'trafficLaw', 'pl1', 'pl2', 'pl3', 'simulation'];
  const missing = requiredKeys.filter(k => !found.has(k));
  console.log('[SCRAPE] Số mục đọc được:', found.size, '/8');

  if (missing.length) {
    throw new Error('Đọc tiến độ chưa đầy đủ, còn thiếu: ' + missing.join(', ') + '. Không ghi đè Google Sheets.');
  }

  const anyProgress = Object.values(scores).some(v => Number(v) > 0);
  const completed = [passed.ethics, passed.drivingTechnique, passed.vehicleStructure, passed.trafficLaw, passed.simulation].every(Boolean);
  const status = completed ? 'Hoàn thành' : (anyProgress ? 'Đang học' : 'Chưa học');
  const result = {
    scores, passed, completed, status, sourceUrl: page.url(), syncedAt: new Date().toISOString(),
    ethics: scores.ethics, drivingTechnique: scores.drivingTechnique, vehicleStructure: scores.vehicleStructure,
    trafficLaw: scores.trafficLaw, pl1: scores.pl1, pl2: scores.pl2, pl3: scores.pl3, simulation: scores.simulation
  };
  console.log('[SCRAPE] Kết quả cuối:', JSON.stringify(result));
  return result;
}

// ============================================================
// SYNC ONE STUDENT
// ============================================================

async function syncStudent(
  browser,
  student
) {
  const username =
    String(
      student.cccd || ''
    ).trim();

  const masked =
    maskUsername(username);

  console.log(
    `[SYNC] Bắt đầu học viên: ${student.name ||
    student.fullName ||
    student.studentName ||
    ''
    } - ${masked}`
  );

  const context =
    await browser.newContext({
      viewport: {
        width: 1365,
        height: 900
      },

      locale: 'vi-VN',

      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/130.0.0.0 Safari/537.36'
    });

  const page =
    await context.newPage();

  page.setDefaultTimeout(
    20000
  );

  try {
    if (!username) {
      throw new Error(
        'Học viên chưa có CCCD.'
      );
    }

    await login(
      page,
      username,
      DEFAULT_PASSWORD
    );

    await openProgressPage(
      page
    );

    const progress =
      await scrapeProgress(
        page
      );

    console.log(
      `[SYNC] Thành công ${masked}: ${progress.status}`
    );

    return {
      ...student,
      scores:
        progress.scores,
      ethics: progress.scores.ethics,
      drivingTechnique: progress.scores.drivingTechnique,
      vehicleStructure: progress.scores.vehicleStructure,
      trafficLaw: progress.scores.trafficLaw,
      pl1: progress.scores.pl1,
      pl2: progress.scores.pl2,
      pl3: progress.scores.pl3,
      simulation: progress.scores.simulation,
      passed:
        progress.passed,
      completed:
        progress.completed,
      status:
        progress.status,
      sourceUrl:
        progress.sourceUrl,
      syncedAt:
        progress.syncedAt,
      error: ''
    };
  } catch (error) {
    console.error(
      `[SYNC] Lỗi ${masked}:`,
      error.stack ||
      error.message
    );

    return {
      ...student,
      scores: {},
      passed: {},
      completed: false,
      status:
        'Lỗi đồng bộ',
      error:
        error.message ||
        String(error),
      syncedAt:
        new Date().toISOString()
    };
  } finally {
    await context
      .close()
      .catch(() => { });
  }
}

// ============================================================
// CALLBACK
// ============================================================

async function callback(
  url,
  jobId,
  result
) {
  const body =
    new URLSearchParams();

  body.set(
    'data',
    JSON.stringify({
      action:
        'theory.workerCallback',
      secret:
        SECRET,
      jobId,
      result
    })
  );

  console.log(
    `[CALLBACK] Job ${jobId} -> Apps Script`
  );

  const response =
    await fetch(url, {
      method: 'POST',

      headers: {
        'content-type':
          'application/x-www-form-urlencoded;charset=UTF-8'
      },

      body
    });

  const text =
    await response
      .text()
      .catch(() => '');

  console.log(
    '[CALLBACK] HTTP:',
    response.status
  );

  if (!response.ok) {
    throw new Error(
      `Callback HTTP ${response.status}: ${text.slice(0, 300)}`
    );
  }
}

// ============================================================
// RUN JOB
// ============================================================

async function runJob(job) {
  let browser;

  try {
    if (!DEFAULT_PASSWORD) {
      throw new Error(
        'Thiếu HUELMS_DEFAULT_PASSWORD.'
      );
    }

    console.log(
      `[JOB] Bắt đầu job ${job.id}`
    );

    browser =
      await chromium.launch({
        headless: true,

        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu'
        ]
      });

    job.status =
      'running';

    for (
      let i = 0;
      i <
      job.students.length;
      i++
    ) {
      console.log(
        `[JOB] Xử lý ${i + 1
        }/${job.students.length}`
      );

      const result =
        await syncStudent(
          browser,
          job.students[i]
        );

      try {
        await callback(
          job.callbackUrl,
          job.id,
          result
        );
      } catch (error) {
        console.error(
          '[CALLBACK] Lỗi:',
          error.message
        );
      }

      job.processed =
        i + 1;

      if (result.error) {
        job.errors += 1;
      }

      console.log(
        `[JOB] Tiến độ: ${job.processed}/${job.total}, lỗi: ${job.errors}`
      );

      if (
        i <
        job.students.length - 1
      ) {
        await sleep(
          job.delayMs
        );
      }
    }

    job.status =
      'done';

    console.log(
      `[JOB] Hoàn thành job ${job.id}`
    );
  } catch (error) {
    console.error(
      `[JOB] Lỗi:`,
      error.stack ||
      error.message
    );

    job.status =
      'failed';

    job.error =
      error.message ||
      String(error);
  } finally {
    if (browser) {
      await browser
        .close()
        .catch(() => { });
    }

    job.finishedAt =
      new Date().toISOString();
  }
}

// ============================================================
// HEALTH
// ============================================================

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service:
      'huelms-sync'
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service:
      'huelms-sync',
    time:
      new Date().toISOString()
  });
});

// ============================================================
// POST /jobs
// ============================================================

app.post('/jobs', (req, res) => {
  try {
    assertSecret(
      req.body.secret
    );

    if (!req.body.callbackUrl) {
      return res
        .status(400)
        .json({
          error:
            'Thiếu callbackUrl'
        });
    }

    const students =
      Array.isArray(
        req.body.students
      )
        ? req.body.students.filter(
          student =>
            student &&
            student.cccd
        )
        : [];

    if (!students.length) {
      return res
        .status(400)
        .json({
          error:
            'Không có học viên hợp lệ'
        });
    }

    if (students.length > 20) {
      return res
        .status(400)
        .json({
          error:
            'Tối đa 20 học viên/lần'
        });
    }

    const id =
      crypto.randomUUID();

    const delayMs =
      Math.max(
        1200,
        Math.min(
          5000,
          Number(
            req.body.delayMs ||
            1800
          )
        )
      );

    const job = {
      id,
      status:
        'queued',
      processed: 0,
      errors: 0,
      total:
        students.length,
      students,
      callbackUrl:
        req.body.callbackUrl,
      delayMs,
      createdAt:
        new Date().toISOString(),
      finishedAt: '',
      error: ''
    };

    jobs.set(id, job);

    console.log(
      `[POST /jobs] Tạo job ${id}`
    );

    setImmediate(
      () =>
        runJob(job)
    );

    return res
      .status(202)
      .json({
        jobId:
          id,
        total:
          students.length,
        status:
          'queued'
      });
  } catch (error) {
    console.error(
      '[POST /jobs] Lỗi:',
      error.message
    );

    return res
      .status(
        error.message ===
          'UNAUTHORIZED'
          ? 401
          : 500
      )
      .json({
        error:
          error.message ||
          String(error)
      });
  }
});

// ============================================================
// GET /jobs/:id
// ============================================================

app.get('/jobs/:id', (req, res) => {
  try {
    assertSecret(
      String(
        req.get(
          'X-Theory-Secret'
        ) || ''
      )
    );

    const job =
      jobs.get(
        req.params.id
      );

    if (!job) {
      return res
        .status(404)
        .json({
          error:
            'Không tìm thấy job'
        });
    }

    return res.json({
      id:
        job.id,
      status:
        job.status,
      processed:
        job.processed,
      total:
        job.total,
      errors:
        job.errors,
      error:
        job.error || '',
      createdAt:
        job.createdAt,
      finishedAt:
        job.finishedAt || ''
    });
  } catch (error) {
    return res
      .status(
        error.message ===
          'UNAUTHORIZED'
          ? 401
          : 500
      )
      .json({
        error:
          error.message ||
          String(error)
      });
  }
});

// ============================================================
// START
// ============================================================

app.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      `HueLMS sync worker listening on :${PORT}`
    );

    console.log(
      `HueLMS URL: ${BASE_URL}`
    );

    console.log(
      'THEORY_SYNC_SECRET:',
      SECRET
        ? 'Đã cấu hình'
        : 'CHƯA CẤU HÌNH'
    );

    console.log(
      'HUELMS_DEFAULT_PASSWORD:',
      DEFAULT_PASSWORD
        ? 'Đã cấu hình'
        : 'CHƯA CẤU HÌNH'
    );
  }
);