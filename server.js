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
  const text = String(value || '');

  const match = text.match(
    /(\d+(?:[.,]\d+)?)\s*%/
  );

  if (!match) {
    return null;
  }

  const number = Number(
    match[1].replace(',', '.')
  );

  return Number.isFinite(number)
    ? number
    : null;
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
  console.log(
    '[PROGRESS] Tìm ID trang chi tiết...'
  );

  console.log(
    '[PROGRESS] URL hiện tại:',
    page.url()
  );

  const currentMatch =
    page
      .url()
      .match(
        /\/student\/ep\/(\d+)/
      );

  if (currentMatch) {
    console.log(
      '[PROGRESS] Đã ở đúng trang chi tiết:',
      page.url()
    );

    return;
  }

  let epId = null;

  // ----------------------------------------------------------
  // 1. HTML
  // ----------------------------------------------------------

  try {
    const html =
      await page.content();

    const match =
      html.match(
        /\/student\/ep\/(\d+)/
      );

    if (match) {
      epId = match[1];

      console.log(
        '[PROGRESS] Tìm thấy ID trong HTML:',
        epId
      );
    }
  } catch (_) { }

  // ----------------------------------------------------------
  // 2. HREF
  // ----------------------------------------------------------

  if (!epId) {
    try {
      const hrefs =
        await page
          .locator('a[href]')
          .evaluateAll(elements =>
            elements.map(
              el => el.href || ''
            )
          );

      for (const href of hrefs) {
        const match =
          String(href).match(
            /\/student\/ep\/(\d+)/
          );

        if (match) {
          epId = match[1];

          console.log(
            '[PROGRESS] Tìm thấy ID trong href:',
            epId
          );

          break;
        }
      }
    } catch (_) { }
  }

  // ----------------------------------------------------------
  // 3. PERFORMANCE RESOURCE
  // ----------------------------------------------------------

  if (!epId) {
    try {
      const resources =
        await page.evaluate(() =>
          performance
            .getEntriesByType('resource')
            .map(
              item => item.name
            )
        );

      for (const resource of resources) {
        const match =
          String(resource).match(
            /\/student\/ep\/(\d+)/
          );

        if (match) {
          epId = match[1];

          console.log(
            '[PROGRESS] Tìm thấy ID trong resource:',
            epId
          );

          break;
        }
      }
    } catch (_) { }
  }

  // ----------------------------------------------------------
  // 4. STORAGE
  // ----------------------------------------------------------

  if (!epId) {
    try {
      const storage =
        await page.evaluate(() => {
          const result = {};

          for (
            let i = 0;
            i < localStorage.length;
            i++
          ) {
            const key =
              localStorage.key(i);

            result[
              'local:' + key
            ] =
              localStorage.getItem(key);
          }

          for (
            let i = 0;
            i < sessionStorage.length;
            i++
          ) {
            const key =
              sessionStorage.key(i);

            result[
              'session:' + key
            ] =
              sessionStorage.getItem(key);
          }

          return result;
        });

      const match =
        JSON.stringify(storage)
          .match(
            /\/student\/ep\/(\d+)/
          );

      if (match) {
        epId = match[1];

        console.log(
          '[PROGRESS] Tìm thấy ID trong storage:',
          epId
        );
      }
    } catch (_) { }
  }

  // ----------------------------------------------------------
  // 5. NGHE NETWORK TRONG 5 GIÂY
  // ----------------------------------------------------------

  if (!epId) {
    console.log(
      '[PROGRESS] Chưa thấy ID, nghe network trong 5 giây...'
    );

    let networkId = null;

    const detect = url => {
      const match =
        String(url || '').match(
          /\/student\/ep\/(\d+)/
        );

      if (match) {
        networkId = match[1];
      }
    };

    const onRequest =
      request => {
        detect(request.url());
      };

    const onResponse =
      response => {
        detect(response.url());
      };

    page.on(
      'request',
      onRequest
    );

    page.on(
      'response',
      onResponse
    );

    await page.waitForTimeout(
      5000
    );

    page.off(
      'request',
      onRequest
    );

    page.off(
      'response',
      onResponse
    );

    if (networkId) {
      epId = networkId;

      console.log(
        '[PROGRESS] Tìm thấy ID từ network:',
        epId
      );
    }
  }

  // ----------------------------------------------------------
  // 6. NẾU TRONG 5 GIÂY TỰ REDIRECT THÌ NHẬN LUÔN
  // ----------------------------------------------------------

  if (!epId) {
    const redirectMatch =
      page
        .url()
        .match(
          /\/student\/ep\/(\d+)/
        );

    if (redirectMatch) {
      epId = redirectMatch[1];

      console.log(
        '[PROGRESS] Tự redirect được ID:',
        epId
      );
    }
  }

  // ----------------------------------------------------------
  // 7. MỞ TRỰC TIẾP
  // ----------------------------------------------------------

  if (epId) {
    const target =
      `${BASE_URL}/student/ep/${epId}`;

    console.log(
      '[PROGRESS] Mở trực tiếp:',
      target
    );

    await page.goto(
      target,
      {
        waitUntil:
          'domcontentloaded',

        timeout:
          60000
      }
    );

    await page.waitForTimeout(
      1200
    );

    console.log(
      '[PROGRESS] URL sau khi mở:',
      page.url()
    );

    if (
      /\/student\/ep\/\d+\/?$/.test(
        page.url()
      )
    ) {
      console.log(
        '[PROGRESS] Vào trang chi tiết thành công.'
      );

      return;
    }
  }

  throw new Error(
    'Đăng nhập HueLMS thành công nhưng chưa xác định được ID trang /student/ep/{ID}. URL hiện tại: ' +
    page.url()
  );
}

// ============================================================
// SCRAPE PROGRESS
// ============================================================

async function scrapeProgress(page) {
  console.log(
    '[SCRAPE] Đọc tiến độ HueLMS...'
  );

  console.log(
    '[SCRAPE] URL:',
    page.url()
  );

  await page.waitForTimeout(
    1000
  );

  const tables =
    await page
      .locator('table')
      .evaluateAll(tables =>
        tables.map(table =>
          Array.from(
            table.querySelectorAll(
              'tr'
            )
          ).map(tr =>
            Array.from(
              tr.querySelectorAll(
                'th,td'
              )
            )
              .map(td =>
                (
                  td.innerText ||
                  td.textContent ||
                  ''
                )
                  .replace(
                    /\s+/g,
                    ' '
                  )
                  .trim()
              )
              .filter(Boolean)
          )
        )
      )
      .catch(() => []);

  const scores = {
    ethics: 0,
    drivingTechnique: 0,
    vehicleStructure: 0,
    trafficLaw: 0,
    pl1: 0,
    pl2: 0,
    pl3: 0,
    simulation: 0
  };

  const passed = {
    ethics: false,
    drivingTechnique: false,
    vehicleStructure: false,
    trafficLaw: false,
    pl1: false,
    pl2: false,
    pl3: false,
    simulation: false
  };

  function assign(
    rowText,
    percent,
    isPassed
  ) {
    if (
      rowText.includes(
        'dao duc nguoi lai xe'
      ) ||
      rowText.includes(
        'dao duc'
      ) ||
      rowText.includes(
        'vhgt'
      ) ||
      rowText.includes(
        'pccc'
      )
    ) {
      scores.ethics = percent;
      passed.ethics = isPassed;
      return;
    }

    if (
      rowText.includes(
        'ky thuat lai xe'
      )
    ) {
      scores.drivingTechnique =
        percent;

      passed.drivingTechnique =
        isPassed;

      return;
    }

    if (
      rowText.includes(
        'cau tao sua chua'
      ) ||
      (
        rowText.includes(
          'cau tao'
        ) &&
        rowText.includes(
          'sua chua'
        )
      )
    ) {
      scores.vehicleStructure =
        percent;

      passed.vehicleStructure =
        isPassed;

      return;
    }

    if (
      rowText.includes(
        'phap luat giao thong duong bo'
      ) ||
      rowText.includes(
        'phap luat gtdb'
      )
    ) {
      scores.trafficLaw =
        percent;

      passed.trafficLaw =
        isPassed;

      return;
    }

    if (
      rowText.includes(
        'phan 1'
      ) ||
      rowText.includes(
        'pl1'
      )
    ) {
      scores.pl1 = percent;
      passed.pl1 = isPassed;
      return;
    }

    if (
      rowText.includes(
        'phan 2'
      ) ||
      rowText.includes(
        'pl2'
      )
    ) {
      scores.pl2 = percent;
      passed.pl2 = isPassed;
      return;
    }

    if (
      rowText.includes(
        'phan 3'
      ) ||
      rowText.includes(
        'pl3'
      )
    ) {
      scores.pl3 = percent;
      passed.pl3 = isPassed;
      return;
    }

    if (
      rowText.includes(
        'mo phong cac tinh huong giao thong'
      ) ||
      rowText.includes(
        'mo phong'
      )
    ) {
      scores.simulation =
        percent;

      passed.simulation =
        isPassed;
    }
  }

  for (const table of tables) {
    for (const cells of table) {
      if (!cells.length) {
        continue;
      }

      const fullText =
        cells.join(' ');

      const rowText =
        norm(fullText);

      const percent =
        parsePercent(fullText);

      /*
       * Chỉ nhận dòng có %.
       * Nhờ vậy không lấy nhầm bảng điểm phía dưới.
       */
      if (percent === null) {
        continue;
      }

      const isPassed =
        rowText
          .split(' ')
          .includes('dat');

      assign(
        rowText,
        percent,
        isPassed
      );
    }
  }

  const anyProgress =
    Object.values(scores)
      .some(
        value =>
          Number(value) > 0
      );

  const mainPassed = [
    passed.ethics,
    passed.drivingTechnique,
    passed.vehicleStructure,
    passed.trafficLaw,
    passed.simulation
  ];

  const completed =
    mainPassed.every(Boolean);

  let status =
    'Chưa học';

  if (completed) {
    status =
      'Hoàn thành';
  } else if (anyProgress) {
    status =
      'Đang học';
  }

  const result = {
    scores,
    passed,
    completed,
    status,
    sourceUrl:
      page.url(),
    syncedAt:
      new Date().toISOString()
  };

  console.log(
    '[SCRAPE] Kết quả:',
    JSON.stringify(result)
  );

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