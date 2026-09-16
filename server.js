const express = require('express');
const { chromium } = require('playwright');

const app = express();

app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.PORT || 3000);
const THEORY_SYNC_SECRET = String(
  process.env.THEORY_SYNC_SECRET || ''
).trim();

const HUELMS_BASE_URL = String(
  process.env.HUELMS_BASE_URL || 'https://vietmy.huelms.com'
).replace(/\/+$/, '');

const HUELMS_DEFAULT_PASSWORD = String(
  process.env.HUELMS_DEFAULT_PASSWORD || '123456'
);

const MAX_CONCURRENCY = Math.max(
  1,
  Number(process.env.MAX_CONCURRENCY || 1)
);

/* =========================================================
   UTILITIES
========================================================= */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function maskUsername(value) {
  const text = String(value || '').trim();

  if (!text) return '';

  if (text.length <= 4) {
    return '*'.repeat(text.length);
  }

  return text.slice(0, 4) + '*'.repeat(
    Math.max(4, text.length - 4)
  );
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeScore(value) {
  const text = normalizeText(value);

  if (!text) return null;

  const match = text.match(/(\d+(?:[.,]\d+)?)/);

  if (!match) return null;

  const number = Number(match[1].replace(',', '.'));

  if (!Number.isFinite(number)) {
    return null;
  }

  return Math.max(0, Math.min(100, number));
}

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();

      if (
        await locator.count() > 0 &&
        await locator.isVisible().catch(() => false)
      ) {
        return locator;
      }
    } catch (_) { }
  }

  return null;
}

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'huelms-sync'
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'huelms-sync'
  });
});

/* =========================================================
   AUTHENTICATION
========================================================= */

function verifySecret(req, res, next) {
  if (!THEORY_SYNC_SECRET) {
    return res.status(500).json({
      ok: false,
      error: 'THEORY_SYNC_SECRET chưa được cấu hình trên Render.'
    });
  }

  const secret =
    req.headers['x-theory-sync-secret'] ||
    req.headers['x-sync-secret'] ||
    req.body?.secret ||
    '';

  if (String(secret).trim() !== THEORY_SYNC_SECRET) {
    return res.status(401).json({
      ok: false,
      error: 'Sai THEORY_SYNC_SECRET.'
    });
  }

  next();
}

/* =========================================================
   LOGIN HUELMS
========================================================= */

async function loginHueLMS(page, username, password) {
  const masked = maskUsername(username);

  console.log(`[LOGIN] Bắt đầu: ${masked}`);

  await page.goto(HUELMS_BASE_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  console.log('[LOGIN] URL ban đầu:', page.url());

  await page.waitForTimeout(1500);

  let userInput = await firstVisible(page, [
    'input[name="username"]',
    'input[name="userName"]',
    'input[name="login"]',
    'input[name="email"]',
    'input[id*="username" i]',
    'input[id*="login" i]',
    'input[placeholder*="Tên đăng nhập" i]',
    'input[placeholder*="tài khoản" i]',
    'input[type="text"]'
  ]);

  let passInput = await firstVisible(page, [
    'input[name="password"]',
    'input[name="Password"]',
    'input[id*="password" i]',
    'input[placeholder*="mật khẩu" i]',
    'input[type="password"]'
  ]);

  /*
   * Nếu trang chủ không có form login,
   * mở trực tiếp /user/login.
   */
  if (!userInput || !passInput) {
    console.log(
      '[LOGIN] Chưa thấy form ở trang đầu, thử mở trực tiếp /user/login'
    );

    await page.goto(`${HUELMS_BASE_URL}/user/login`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await page.waitForTimeout(1500);

    console.log('[LOGIN] URL form:', page.url());

    userInput = await firstVisible(page, [
      'input[name="username"]',
      'input[name="userName"]',
      'input[name="login"]',
      'input[name="email"]',
      'input[id*="username" i]',
      'input[id*="login" i]',
      'input[placeholder*="Tên đăng nhập" i]',
      'input[placeholder*="tài khoản" i]',
      'input[type="text"]'
    ]);

    passInput = await firstVisible(page, [
      'input[name="password"]',
      'input[name="Password"]',
      'input[id*="password" i]',
      'input[placeholder*="mật khẩu" i]',
      'input[type="password"]'
    ]);
  }

  if (!userInput || !passInput) {
    throw new Error(
      `Không tìm thấy form đăng nhập HueLMS. URL hiện tại: ${page.url()}`
    );
  }

  console.log('[LOGIN] Đã tìm thấy form đăng nhập.');

  await userInput.fill(String(username));
  await passInput.fill(String(password));

  console.log('[LOGIN] Đã nhập tài khoản và mật khẩu.');

  /*
   * HueLMS có thể không dùng button[type=submit] chuẩn.
   * Thử nhiều cách khác nhau.
   */
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
      const locator = page.locator(selector).first();

      if (
        await locator.count() > 0 &&
        await locator.isVisible().catch(() => false)
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
    } catch (error) {
      console.log(
        `[LOGIN] Selector ${selector} không click được:`,
        error.message
      );
    }
  }

  /*
   * Nếu HueLMS dùng component JavaScript đặc biệt,
   * thử click button dựa theo text trong DOM.
   */
  if (!submitted) {
    console.log(
      '[LOGIN] Thử tìm nút bằng nội dung text trong DOM...'
    );

    try {
      submitted = await page.evaluate(() => {
        const elements = Array.from(
          document.querySelectorAll(
            'button, input[type="submit"], a, [role="button"], .btn'
          )
        );

        const target = elements.find(el => {
          const text = String(
            el.innerText ||
            el.value ||
            el.textContent ||
            ''
          )
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();

          return (
            text === 'đăng nhập' ||
            text.includes('đăng nhập')
          );
        });

        if (!target) {
          return false;
        }

        target.click();
        return true;
      });

      if (submitted) {
        console.log(
          '[LOGIN] Đã click nút bằng JavaScript DOM.'
        );
      }
    } catch (error) {
      console.log(
        '[LOGIN] DOM click thất bại:',
        error.message
      );
    }
  }

  /*
   * Fallback cuối cùng:
   * Enter trong ô password.
   */
  if (!submitted) {
    console.log(
      '[LOGIN] Không tìm thấy button chuẩn, thử nhấn Enter...'
    );

    try {
      await passInput.press('Enter');
      submitted = true;
    } catch (error) {
      console.log(
        '[LOGIN] Enter thất bại:',
        error.message
      );
    }
  }

  if (!submitted) {
    const buttons = await page
      .locator(
        'button, input[type="submit"], [role="button"], a'
      )
      .evaluateAll(elements =>
        elements.map(el => ({
          tag: el.tagName,
          text: (
            el.innerText ||
            el.value ||
            el.textContent ||
            ''
          ).trim(),
          type: el.type || '',
          id: el.id || '',
          className:
            typeof el.className === 'string'
              ? el.className
              : ''
        }))
      )
      .catch(() => []);

    console.log(
      '[LOGIN] Các phần tử có thể click:',
      JSON.stringify(buttons)
    );

    throw new Error(
      'Không thể gửi form đăng nhập HueLMS.'
    );
  }

  console.log(
    '[LOGIN] Đã gửi form, chờ HueLMS xử lý...'
  );

  /*
   * Không dùng networkidle vì LMS có thể giữ
   * request nền liên tục.
   */
  await Promise.race([
    page.waitForURL(
      url => !url.toString().includes('/user/login'),
      {
        timeout: 15000
      }
    ).catch(() => null),

    page.waitForTimeout(5000)
  ]);

  await page.waitForTimeout(1500);

  console.log(
    '[LOGIN] URL sau đăng nhập:',
    page.url()
  );

  console.log(
    '[LOGIN] Title sau đăng nhập:',
    await page.title().catch(() => '')
  );

  /*
   * Kiểm tra xem form password còn hiển thị hay không.
   */
  const visiblePassword = await page
    .locator('input[type="password"]')
    .first()
    .isVisible()
    .catch(() => false);

  if (visiblePassword) {
    const errorText = await page
      .locator(
        '.alert, .error, .invalid-feedback, .validation-summary-errors'
      )
      .allTextContents()
      .catch(() => []);

    const message = errorText
      .map(normalizeText)
      .filter(Boolean)
      .join(' | ');

    throw new Error(
      message
        ? `HueLMS vẫn ở trang đăng nhập: ${message}`
        : `HueLMS vẫn ở trang đăng nhập sau khi gửi tài khoản. URL: ${page.url()}`
    );
  }

  console.log(
    `[LOGIN] Đăng nhập thành công: ${masked}`
  );

  return true;
}

/* =========================================================
   FIND STUDENT PROGRESS PAGE
========================================================= */

async function openProgressPage(page) {
  console.log(
    '[PROGRESS] Bắt đầu tìm trang tiến độ...'
  );

  /*
   * Nếu sau login HueLMS đã chuyển thẳng tới
   * /student/ep/... thì dùng luôn.
   */
  if (page.url().includes('/student/ep/')) {
    console.log(
      '[PROGRESS] Đang ở trang student/ep:',
      page.url()
    );

    return page.url();
  }

  /*
   * Tìm link /student/ep/... trong trang hiện tại.
   */
  let epLink = await page
    .locator('a[href*="/student/ep/"]')
    .first()
    .getAttribute('href')
    .catch(() => null);

  if (epLink) {
    const target = new URL(
      epLink,
      HUELMS_BASE_URL
    ).toString();

    console.log(
      '[PROGRESS] Tìm thấy link:',
      target
    );

    await page.goto(target, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await page.waitForTimeout(1500);

    return page.url();
  }

  /*
   * Tìm tất cả link có thể liên quan đến khóa học.
   */
  const links = await page
    .locator('a[href]')
    .evaluateAll(elements =>
      elements.map(el => ({
        text: (
          el.innerText ||
          el.textContent ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim(),

        href: el.href || ''
      }))
    )
    .catch(() => []);

  const candidates = links.filter(item => {
    const text = item.text.toLowerCase();
    const href = item.href.toLowerCase();

    return (
      href.includes('/student/') ||
      text.includes('khóa học') ||
      text.includes('khoá học') ||
      text.includes('chương trình') ||
      text.includes('tiến độ') ||
      text.includes('bảng điểm')
    );
  });

  console.log(
    '[PROGRESS] Link ứng viên:',
    JSON.stringify(candidates.slice(0, 30))
  );

  /*
   * Ưu tiên link student.
   */
  const studentLink = candidates.find(
    item =>
      item.href &&
      item.href.includes('/student/')
  );

  if (studentLink) {
    console.log(
      '[PROGRESS] Thử mở:',
      studentLink.href
    );

    await page.goto(studentLink.href, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await page.waitForTimeout(1500);

    if (page.url().includes('/student/ep/')) {
      return page.url();
    }

    epLink = await page
      .locator('a[href*="/student/ep/"]')
      .first()
      .getAttribute('href')
      .catch(() => null);

    if (epLink) {
      const target = new URL(
        epLink,
        HUELMS_BASE_URL
      ).toString();

      await page.goto(target, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });

      await page.waitForTimeout(1500);

      return page.url();
    }
  }

  /*
   * Có một số LMS tải link sau khi JavaScript chạy.
   */
  await page.waitForTimeout(2500);

  epLink = await page
    .locator('a[href*="/student/ep/"]')
    .first()
    .getAttribute('href')
    .catch(() => null);

  if (epLink) {
    const target = new URL(
      epLink,
      HUELMS_BASE_URL
    ).toString();

    await page.goto(target, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await page.waitForTimeout(1500);

    return page.url();
  }

  throw new Error(
    `Đăng nhập thành công nhưng chưa tìm thấy trang tiến độ /student/ep/. URL hiện tại: ${page.url()}`
  );
}

/* =========================================================
   READ COURSE SCORE / PROGRESS
========================================================= */

async function readProgress(page) {
  console.log(
    '[PROGRESS] Đọc dữ liệu:',
    page.url()
  );

  await page.waitForTimeout(1500);

  const bodyText = normalizeText(
    await page.locator('body').innerText()
  );

  if (
    !bodyText.includes('Bảng điểm') &&
    !bodyText.includes('bảng điểm')
  ) {
    console.log(
      '[PROGRESS] Không thấy chữ "Bảng điểm" rõ ràng, vẫn thử phân tích bảng.'
    );
  }

  /*
   * Đọc toàn bộ row của table.
   */
  const rows = await page
    .locator('table tr')
    .evaluateAll(elements =>
      elements.map(row => {
        const cells = Array.from(
          row.querySelectorAll('th, td')
        ).map(cell =>
          (cell.innerText || cell.textContent || '')
            .replace(/\s+/g, ' ')
            .trim()
        );

        return cells;
      }).filter(cells => cells.length)
    )
    .catch(() => []);

  console.log(
    `[PROGRESS] Số dòng bảng: ${rows.length}`
  );

  /*
   * Một số trang dùng div thay table.
   * Body text vẫn được dùng làm fallback.
   */
  const allLines = bodyText
    .split(/\n+/)
    .map(normalizeText)
    .filter(Boolean);

  function findScoreByKeywords(keywords) {
    /*
     * Cách 1: tìm trong table.
     */
    for (const cells of rows) {
      const line = cells.join(' | ');
      const lower = line.toLowerCase();

      if (
        keywords.some(keyword =>
          lower.includes(keyword)
        )
      ) {
        /*
         * Đi từ cuối row về đầu để lấy số %
         * hoặc điểm hoàn thành.
         */
        for (
          let i = cells.length - 1;
          i >= 0;
          i--
        ) {
          const value = normalizeScore(cells[i]);

          if (value !== null) {
            return value;
          }
        }
      }
    }

    /*
     * Cách 2: tìm trong text.
     */
    for (const line of allLines) {
      const lower = line.toLowerCase();

      if (
        keywords.some(keyword =>
          lower.includes(keyword)
        )
      ) {
        const percentMatch =
          line.match(/(\d+(?:[.,]\d+)?)\s*%/);

        if (percentMatch) {
          return normalizeScore(
            percentMatch[1]
          );
        }
      }
    }

    return 0;
  }

  /*
   * Pháp luật:
   * Trong ảnh HueLMS của bạn có:
   * Pháp luật GTĐB
   * PL1
   * PL2
   * PL3
   *
   * Ưu tiên dòng tổng "Pháp luật GTĐB".
   */
  const law = findScoreByKeywords([
    'pháp luật gtđb',
    'phap luat gtdb',
    'pháp luật giao thông',
    'phap luat giao thong'
  ]);

  /*
   * Kỹ thuật:
   * HueLMS hiển thị "Kỹ thuật lái xe".
   */
  const technique = findScoreByKeywords([
    'kỹ thuật lái xe',
    'ky thuat lai xe',
    'kỹ thuật',
    'ky thuat'
  ]);

  /*
   * Mô phỏng.
   */
  const simulation = findScoreByKeywords([
    'mô phỏng',
    'mo phong'
  ]);

  /*
   * Các phần khác để lưu chi tiết.
   */
  const ethics = findScoreByKeywords([
    'đạo đức',
    'dao duc',
    'vhgt',
    'pccc'
  ]);

  const repair = findScoreByKeywords([
    'cấu tạo sửa chữa',
    'cau tao sua chua',
    'sửa chữa',
    'sua chua'
  ]);

  const pl1 = findScoreByKeywords([
    'pl1',
    'luật trật tự',
    'luat trat tu'
  ]);

  const pl2 = findScoreByKeywords([
    'pl2',
    'biển báo',
    'bien bao'
  ]);

  const pl3 = findScoreByKeywords([
    'pl3',
    'xử lý thgt',
    'xu ly thgt'
  ]);

  /*
   * Hoàn thành:
   * Tạm xác định dựa trên 3 nhóm mà frontend
   * đang hiển thị: pháp luật, kỹ thuật, mô phỏng.
   */
  const completed =
    law >= 100 &&
    technique >= 100 &&
    simulation >= 100;

  let status = 'Đang học';

  if (completed) {
    status = 'Hoàn thành';
  } else if (
    law === 0 &&
    technique === 0 &&
    simulation === 0
  ) {
    status = 'Chưa học';
  }

  const result = {
    law,
    technique,
    simulation,

    status,
    completed,

    detail: {
      ethics,
      repair,
      pl1,
      pl2,
      pl3
    },

    sourceUrl: page.url(),
    syncedAt: new Date().toISOString()
  };

  console.log(
    '[PROGRESS] Kết quả:',
    JSON.stringify(result)
  );

  return result;
}

/* =========================================================
   SYNC ONE STUDENT
========================================================= */

async function syncStudent(student) {
  const username = String(
    student.cccd ||
    student.username ||
    ''
  ).trim();

  const password = String(
    student.password ||
    HUELMS_DEFAULT_PASSWORD
  );

  if (!username) {
    throw new Error(
      'Học viên chưa có CCCD/tên đăng nhập HueLMS.'
    );
  }

  let browser;

  try {
    console.log(
      '==================================================='
    );

    console.log(
      `[SYNC] Bắt đầu học viên: ${student.name ||
      student.fullName ||
      student.code ||
      ''
      } - ${maskUsername(username)}`
    );

    browser = await chromium.launch({
      headless: true,

      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    const context = await browser.newContext({
      viewport: {
        width: 1440,
        height: 1000
      },

      locale: 'vi-VN',

      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/130.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    page.setDefaultTimeout(20000);

    await loginHueLMS(
      page,
      username,
      password
    );

    await openProgressPage(page);

    const progress = await readProgress(page);

    console.log(
      `[SYNC] Thành công: ${maskUsername(username)}`
    );

    return {
      ok: true,

      studentCode:
        student.code ||
        student.studentCode ||
        '',

      cccd: username,

      name:
        student.name ||
        student.fullName ||
        '',

      ...progress
    };
  } catch (error) {
    console.error(
      `[SYNC] Lỗi ${maskUsername(username)}:`,
      error.stack || error.message
    );

    return {
      ok: false,

      studentCode:
        student.code ||
        student.studentCode ||
        '',

      cccd: username,

      name:
        student.name ||
        student.fullName ||
        '',

      error:
        error.message ||
        'Không xác định được lỗi đồng bộ HueLMS.',

      syncedAt: new Date().toISOString()
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => { });
    }
  }
}

/* =========================================================
   CALLBACK TO APPS SCRIPT
========================================================= */

async function callbackToAppsScript(
  callbackUrl,
  callbackSecret,
  payload
) {
  if (!callbackUrl) {
    return;
  }

  console.log(
    '[CALLBACK] Gửi kết quả về Apps Script...'
  );

  const headers = {
    'Content-Type': 'application/json'
  };

  if (callbackSecret) {
    headers['X-Theory-Sync-Secret'] =
      callbackSecret;
  }

  const response = await fetch(callbackUrl, {
    method: 'POST',

    headers,

    body: JSON.stringify(payload),

    redirect: 'follow'
  });

  const text = await response.text();

  console.log(
    '[CALLBACK] HTTP:',
    response.status
  );

  if (!response.ok) {
    throw new Error(
      `Callback Apps Script thất bại HTTP ${response.status}: ${text.slice(0, 300)}`
    );
  }

  console.log(
    '[CALLBACK] Thành công.'
  );
}

/* =========================================================
   CONCURRENCY
========================================================= */

async function mapLimit(
  items,
  limit,
  worker
) {
  const results =
    new Array(items.length);

  let index = 0;

  async function run() {
    while (true) {
      const current = index++;

      if (current >= items.length) {
        return;
      }

      results[current] =
        await worker(
          items[current],
          current
        );
    }
  }

  const workers = [];

  const count = Math.min(
    Math.max(1, limit),
    items.length
  );

  for (let i = 0; i < count; i++) {
    workers.push(run());
  }

  await Promise.all(workers);

  return results;
}

/* =========================================================
   SYNC API
========================================================= */

app.post(
  '/sync',
  verifySecret,
  async (req, res) => {
    try {
      /*
       * Hỗ trợ cả:
       *
       * {
       *   students: [...]
       * }
       *
       * và:
       *
       * {
       *   student: {...}
       * }
       */
      let students = [];

      if (Array.isArray(req.body.students)) {
        students = req.body.students;
      } else if (req.body.student) {
        students = [req.body.student];
      } else if (
        req.body.cccd ||
        req.body.username
      ) {
        students = [req.body];
      }

      if (!students.length) {
        return res.status(400).json({
          ok: false,
          error: 'Không có học viên để đồng bộ.'
        });
      }

      /*
       * Frontend của bạn đang giới hạn 20 học viên/lần.
       * Worker cũng giới hạn lại để an toàn.
       */
      if (students.length > 20) {
        return res.status(400).json({
          ok: false,
          error:
            'Mỗi lần chỉ được đồng bộ tối đa 20 học viên.'
        });
      }

      console.log(
        `[SYNC] Nhận yêu cầu ${students.length} học viên.`
      );

      const results = await mapLimit(
        students,
        MAX_CONCURRENCY,
        syncStudent
      );

      const success = results.filter(
        item => item.ok
      ).length;

      const failed =
        results.length - success;

      const responsePayload = {
        ok: failed === 0,

        total: results.length,
        success,
        failed,

        results
      };

      /*
       * Nếu Apps Script gửi callbackUrl thì
       * worker có thể callback.
       */
      const callbackUrl = String(
        req.body.callbackUrl ||
        req.body.callback_url ||
        ''
      ).trim();

      const callbackSecret = String(
        req.body.callbackSecret ||
        req.body.callback_secret ||
        THEORY_SYNC_SECRET
      ).trim();

      if (callbackUrl) {
        try {
          await callbackToAppsScript(
            callbackUrl,
            callbackSecret,
            responsePayload
          );
        } catch (callbackError) {
          console.error(
            '[CALLBACK] Lỗi:',
            callbackError.message
          );

          responsePayload.callbackError =
            callbackError.message;
        }
      }

      return res.json(
        responsePayload
      );
    } catch (error) {
      console.error(
        '[SYNC API] Lỗi:',
        error.stack || error.message
      );

      return res.status(500).json({
        ok: false,

        error:
          error.message ||
          'Lỗi HueLMS worker.'
      });
    }
  }
);

/* =========================================================
   COMPATIBILITY ENDPOINT
========================================================= */

/*
 * Nếu Apps Script hiện tại đang gọi /sync-student
 * thay vì /sync thì endpoint này vẫn sử dụng được.
 */
app.post(
  '/sync-student',
  verifySecret,
  async (req, res) => {
    try {
      const student =
        req.body.student ||
        req.body;

      const result =
        await syncStudent(student);

      res.json(result);
    } catch (error) {
      console.error(
        '[SYNC-STUDENT] Lỗi:',
        error.stack || error.message
      );

      res.status(500).json({
        ok: false,
        error:
          error.message ||
          'Lỗi HueLMS worker.'
      });
    }
  }
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use((error, req, res, next) => {
  console.error(
    '[SERVER ERROR]',
    error.stack || error.message
  );

  res.status(500).json({
    ok: false,

    error:
      error.message ||
      'Internal Server Error'
  });
});

/* =========================================================
   START SERVER
========================================================= */

app.listen(PORT, '0.0.0.0', () => {
  console.log(
    `HueLMS sync worker listening on :${PORT}`
  );

  console.log(
    `HueLMS base URL: ${HUELMS_BASE_URL}`
  );

  console.log(
    `MAX_CONCURRENCY=${MAX_CONCURRENCY}`
  );

  console.log(
    `THEORY_SYNC_SECRET: ${THEORY_SYNC_SECRET
      ? 'Đã cấu hình'
      : 'CHƯA CẤU HÌNH'
    }`
  );
});