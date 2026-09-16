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

function score(value) {
  const match = String(value || '')
    .replace(',', '.')
    .match(/-?\d+(?:\.\d+)?/);

  return match ? Number(match[0]) : 0;
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

// ============================================================
// PLAYWRIGHT HELPERS
// ============================================================

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

// ============================================================
// HUELMS LOGIN
// ============================================================

async function login(page, username, password) {
  const masked = maskUsername(username);

  console.log(
    '==================================================='
  );

  console.log(
    `[LOGIN] Bắt đầu: ${masked}`
  );

  // ----------------------------------------------------------
  // 1. MỞ TRANG CHỦ
  // ----------------------------------------------------------

  await page.goto(BASE_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  await page.waitForTimeout(1500);

  console.log(
    '[LOGIN] URL ban đầu:',
    page.url()
  );

  console.log(
    '[LOGIN] Title:',
    await page.title().catch(() => '')
  );

  // ----------------------------------------------------------
  // 2. TÌM FORM LOGIN Ở TRANG HIỆN TẠI
  // ----------------------------------------------------------

  let userInput = await firstVisible(page, [
    'input[placeholder*="Tên đăng nhập" i]',
    'input[placeholder*="tên đăng nhập" i]',
    'input[placeholder*="tài khoản" i]',
    'input[placeholder*="username" i]',

    'input[name="username"]',
    'input[name="userName"]',
    'input[name="login"]',
    'input[name="account"]',
    'input[name="email"]',

    'input[id*="username" i]',
    'input[id*="login" i]',

    'input[type="text"]'
  ]);

  let passInput = await firstVisible(page, [
    'input[placeholder*="Nhập mật khẩu" i]',
    'input[placeholder*="mật khẩu" i]',

    'input[name="password"]',
    'input[name="Password"]',

    'input[id*="password" i]',

    'input[type="password"]'
  ]);

  // ----------------------------------------------------------
  // 3. NẾU CHƯA THẤY FORM -> MỞ /user/login
  // ----------------------------------------------------------

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

    await page.waitForTimeout(1500);

    console.log(
      '[LOGIN] URL form:',
      page.url()
    );

    userInput = await firstVisible(page, [
      'input[placeholder*="Tên đăng nhập" i]',
      'input[placeholder*="tên đăng nhập" i]',
      'input[placeholder*="tài khoản" i]',
      'input[placeholder*="username" i]',

      'input[name="username"]',
      'input[name="userName"]',
      'input[name="login"]',
      'input[name="account"]',
      'input[name="email"]',

      'input[id*="username" i]',
      'input[id*="login" i]',

      'input[type="text"]'
    ]);

    passInput = await firstVisible(page, [
      'input[placeholder*="Nhập mật khẩu" i]',
      'input[placeholder*="mật khẩu" i]',

      'input[name="password"]',
      'input[name="Password"]',

      'input[id*="password" i]',

      'input[type="password"]'
    ]);
  }

  // ----------------------------------------------------------
  // 4. DEBUG NẾU KHÔNG TÌM THẤY FORM
  // ----------------------------------------------------------

  if (!userInput || !passInput) {
    const inputs = await page
      .locator('input')
      .evaluateAll(elements =>
        elements.map(el => ({
          type: el.type || '',
          name: el.name || '',
          id: el.id || '',
          placeholder: el.placeholder || ''
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

  // ----------------------------------------------------------
  // 5. NHẬP USER + PASSWORD
  // ----------------------------------------------------------

  await userInput.fill(
    String(username).trim()
  );

  await passInput.fill(
    String(password)
  );

  console.log(
    '[LOGIN] Đã nhập tài khoản và mật khẩu.'
  );

  // ----------------------------------------------------------
  // 6. TÌM NÚT ĐĂNG NHẬP
  // ----------------------------------------------------------

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

  for (
    const selector of buttonSelectors
  ) {
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
    } catch (error) {
      console.log(
        `[LOGIN] Không click được ${selector}:`,
        error.message
      );
    }
  }

  // ----------------------------------------------------------
  // 7. FALLBACK: TỰ TÌM ELEMENT THEO TEXT
  // ----------------------------------------------------------

  if (!submitted) {
    console.log(
      '[LOGIN] Thử tìm nút bằng text DOM...'
    );

    try {
      submitted =
        await page.evaluate(() => {
          const elements =
            Array.from(
              document.querySelectorAll(
                [
                  'button',
                  'input[type="submit"]',
                  'a',
                  '[role="button"]',
                  '.btn'
                ].join(',')
              )
            );

          const target =
            elements.find(el => {
              const text =
                String(
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
          '[LOGIN] Đã click nút bằng DOM.'
        );
      }
    } catch (error) {
      console.log(
        '[LOGIN] DOM click thất bại:',
        error.message
      );
    }
  }

  // ----------------------------------------------------------
  // 8. FALLBACK CUỐI: NHẤN ENTER
  // ----------------------------------------------------------

  if (!submitted) {
    console.log(
      '[LOGIN] Không tìm thấy button chuẩn, thử Enter...'
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

  // ----------------------------------------------------------
  // 9. DEBUG NẾU KHÔNG SUBMIT ĐƯỢC
  // ----------------------------------------------------------

  if (!submitted) {
    const buttons =
      await page
        .locator(
          [
            'button',
            'input[type="submit"]',
            '[role="button"]',
            'a'
          ].join(',')
        )
        .evaluateAll(elements =>
          elements.map(el => ({
            tag: el.tagName,
            text:
              (
                el.innerText ||
                el.value ||
                el.textContent ||
                ''
              )
                .replace(/\s+/g, ' ')
                .trim(),

            type: el.type || '',
            id: el.id || '',

            className:
              typeof el.className ===
                'string'
                ? el.className
                : ''
          }))
        )
        .catch(() => []);

    console.log(
      '[LOGIN] Các phần tử click:',
      JSON.stringify(buttons)
    );

    throw new Error(
      'Không thể gửi form đăng nhập HueLMS.'
    );
  }

  console.log(
    '[LOGIN] Đã gửi form đăng nhập.'
  );

  // ----------------------------------------------------------
  // 10. CHỜ CHUYỂN TRANG
  // ----------------------------------------------------------

  await Promise.race([
    page
      .waitForURL(
        url =>
          !url
            .toString()
            .includes('/user/login'),
        {
          timeout: 15000
        }
      )
      .catch(() => null),

    page.waitForTimeout(5000)
  ]);

  await page.waitForTimeout(1500);

  console.log(
    '[LOGIN] URL sau đăng nhập:',
    page.url()
  );

  console.log(
    '[LOGIN] Title sau đăng nhập:',
    await page
      .title()
      .catch(() => '')
  );

  // ----------------------------------------------------------
  // 11. KIỂM TRA LOGIN CÓ THÀNH CÔNG KHÔNG
  // ----------------------------------------------------------

  const visiblePassword =
    await page
      .locator(
        'input[type="password"]'
      )
      .first()
      .isVisible()
      .catch(() => false);

  if (visiblePassword) {
    const bodyText =
      norm(
        await page
          .locator('body')
          .innerText()
          .catch(() => '')
      );

    if (
      bodyText.includes(
        'sai mat khau'
      ) ||
      bodyText.includes(
        'mat khau khong dung'
      ) ||
      bodyText.includes(
        'tai khoan khong dung'
      ) ||
      bodyText.includes(
        'dang nhap that bai'
      )
    ) {
      throw new Error(
        'Sai tài khoản hoặc mật khẩu HueLMS.'
      );
    }

    throw new Error(
      'HueLMS vẫn ở trang đăng nhập sau khi gửi tài khoản. URL: ' +
      page.url()
    );
  }

  console.log(
    `[LOGIN] Đăng nhập thành công: ${masked}`
  );
}

// ============================================================
// OPEN PROGRESS PAGE
// ============================================================

async function openProgressPage(page) {
  console.log(
    '[PROGRESS] Tìm trang tiến độ...'
  );

  console.log(
    '[PROGRESS] URL hiện tại:',
    page.url()
  );

  // ----------------------------------------------------------
  // 1. ĐANG Ở /student/ep/
  // ----------------------------------------------------------

  if (
    page
      .url()
      .includes('/student/ep/')
  ) {
    console.log(
      '[PROGRESS] Đã ở student/ep.'
    );

    return;
  }

  // ----------------------------------------------------------
  // 2. ĐÃ THẤY BẢNG ĐIỂM
  // ----------------------------------------------------------

  const hasGradeTitle =
    (await page
      .locator(
        'text=Bảng điểm khoá học'
      )
      .count()) > 0 ||
    (await page
      .locator(
        'text=Bảng điểm khóa học'
      )
      .count()) > 0;

  if (hasGradeTitle) {
    console.log(
      '[PROGRESS] Đã thấy Bảng điểm khóa học.'
    );

    return;
  }

  // ----------------------------------------------------------
  // 3. TÌM LINK /student/ep/
  // ----------------------------------------------------------

  let direct =
    page
      .locator(
        'a[href*="/student/ep/"]'
      )
      .first();

  if (await direct.count()) {
    const href =
      await direct
        .getAttribute('href')
        .catch(() => '');

    console.log(
      '[PROGRESS] Tìm thấy link:',
      href
    );

    await direct.click();

    await page
      .waitForLoadState(
        'domcontentloaded'
      )
      .catch(() => { });

    await page.waitForTimeout(1200);

    return;
  }

  // ----------------------------------------------------------
  // 4. THỬ CÁC MENU LIÊN QUAN
  // ----------------------------------------------------------

  const candidates = [
    'a:has-text("Chương trình đào tạo")',

    'a:has-text("Khóa học")',

    'a:has-text("Khoá học")',

    'a:has-text("Tiến độ")',

    'a:has-text("Kết quả")',

    'a:has-text("Bảng điểm")',

    'button:has-text("Chi tiết")'
  ];

  for (
    const selector of candidates
  ) {
    const loc =
      page
        .locator(selector)
        .first();

    if (
      await loc.count()
    ) {
      try {
        console.log(
          '[PROGRESS] Thử click:',
          selector
        );

        await loc.click();

        await page.waitForTimeout(
          1200
        );
      } catch (_) { }

      direct =
        page
          .locator(
            'a[href*="/student/ep/"]'
          )
          .first();

      if (
        await direct.count()
      ) {
        console.log(
          '[PROGRESS] Tìm thấy student/ep sau click.'
        );

        await direct.click();

        await page
          .waitForLoadState(
            'domcontentloaded'
          )
          .catch(() => { });

        await page.waitForTimeout(
          1200
        );

        return;
      }

      const hasGrade =
        (await page
          .locator(
            'text=Bảng điểm khoá học'
          )
          .count()) > 0 ||
        (await page
          .locator(
            'text=Bảng điểm khóa học'
          )
          .count()) > 0;

      if (hasGrade) {
        return;
      }
    }
  }

  // ----------------------------------------------------------
  // 5. DEBUG LINK
  // ----------------------------------------------------------

  const links =
    await page
      .locator('a[href]')
      .evaluateAll(elements =>
        elements
          .map(el => ({
            text:
              (
                el.innerText ||
                el.textContent ||
                ''
              )
                .replace(/\s+/g, ' ')
                .trim(),

            href:
              el.href || ''
          }))
          .filter(
            item =>
              item.text ||
              item.href
          )
      )
      .catch(() => []);

  const interestingLinks =
    links.filter(item => {
      const t =
        norm(item.text);

      const h =
        String(
          item.href || ''
        ).toLowerCase();

      return (
        h.includes('/student/') ||
        t.includes('khoa hoc') ||
        t.includes(
          'chuong trinh'
        ) ||
        t.includes('tien do') ||
        t.includes('bang diem')
      );
    });

  console.log(
    '[PROGRESS] Link ứng viên:',
    JSON.stringify(
      interestingLinks.slice(
        0,
        30
      )
    )
  );

  throw new Error(
    'Không tìm thấy trang Bảng điểm khóa học. URL hiện tại: ' +
    page.url()
  );
}

// ============================================================
// SCRAPE SCORES
// ============================================================

async function scrapeScores(page) {
  console.log(
    '[SCRAPE] Đọc bảng điểm...'
  );

  const rows =
    await page
      .locator('table tr')
      .evaluateAll(trs =>
        trs.map(tr =>
          Array.from(
            tr.querySelectorAll(
              'th,td'
            )
          )
            .map(td =>
              (
                td.innerText ||
                ''
              ).trim()
            )
            .filter(Boolean)
        )
      );

  console.log(
    '[SCRAPE] Tổng số dòng:',
    rows.length
  );

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

  for (
    const cells of rows
  ) {
    if (!cells.length) {
      continue;
    }

    const label =
      norm(cells[0]);

    const value =
      score(
        cells[
        cells.length - 1
        ]
      );

    if (
      label.includes(
        'dao duc'
      ) &&
      (
        label.includes(
          'vhgt'
        ) ||
        label.includes(
          'pccc'
        )
      )
    ) {
      scores.ethics =
        value;
    }

    else if (
      label.includes(
        'ky thuat lai xe'
      )
    ) {
      scores.drivingTechnique =
        value;
    }

    else if (
      label.includes(
        'cau tao'
      ) &&
      label.includes(
        'sua chua'
      )
    ) {
      scores.vehicleStructure =
        value;
    }

    else if (
      label.includes(
        'phap luat gtdb'
      )
    ) {
      scores.trafficLaw =
        value;
    }

    else if (
      label.startsWith(
        'pl1'
      )
    ) {
      scores.pl1 =
        value;
    }

    else if (
      label.startsWith(
        'pl2'
      )
    ) {
      scores.pl2 =
        value;
    }

    else if (
      label.startsWith(
        'pl3'
      )
    ) {
      scores.pl3 =
        value;
    }

    else if (
      label.includes(
        'mo phong'
      )
    ) {
      scores.simulation =
        value;
    }
  }

  console.log(
    '[SCRAPE] Kết quả:',
    JSON.stringify(scores)
  );

  return scores;
}

// ============================================================
// DERIVE STATUS
// ============================================================

function deriveStatus(scores) {
  const values =
    Object.values(scores);

  if (
    values.length &&
    values.every(
      value =>
        Number(value) >= 100
    )
  ) {
    return 'Hoàn thành';
  }

  if (
    values.some(
      value =>
        Number(value) > 0
    )
  ) {
    return 'Đang học';
  }

  return 'Chưa học';
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

    const scores =
      await scrapeScores(
        page
      );

    const status =
      deriveStatus(
        scores
      );

    console.log(
      `[SYNC] Thành công ${masked}: ${status}`
    );

    return {
      ...student,

      scores,

      status,

      error: '',

      sourceUrl:
        page.url(),

      syncedAt:
        new Date().toISOString()
    };
  } catch (error) {
    console.error(
      `[SYNC] Lỗi ${masked}:`,
      error.message
    );

    return {
      ...student,

      scores: {},

      status:
        'Lỗi đồng bộ',

      error:
        error &&
          error.message
          ? error.message
          : String(error),

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
// CALLBACK APPS SCRIPT
// ============================================================

async function callback(
  url,
  jobId,
  result
) {
  if (!url) {
    throw new Error(
      'Thiếu callbackUrl'
    );
  }

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

  return text;
}

// ============================================================
// RUN BACKGROUND JOB
// ============================================================

async function runJob(job) {
  let browser;

  try {
    if (!DEFAULT_PASSWORD) {
      throw new Error(
        'Thiếu HUELMS_DEFAULT_PASSWORD trên worker.'
      );
    }

    console.log(
      `[JOB] Bắt đầu job ${job.id}`
    );

    console.log(
      `[JOB] Tổng học viên: ${job.students.length}`
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
      } catch (
      callbackError
      ) {
        console.error(
          '[CALLBACK] Lỗi:',
          callbackError.message
        );

        result.callbackError =
          callbackError.message;
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
      `[JOB] Lỗi job ${job.id}:`,
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

app.get(
  '/',
  (req, res) => {
    res.json({
      ok: true,
      service:
        'huelms-sync'
    });
  }
);

app.get(
  '/health',
  (req, res) => {
    res.json({
      ok: true,

      service:
        'huelms-sync',

      time:
        new Date().toISOString()
    });
  }
);

// ============================================================
// POST /jobs
//
// Endpoint Apps Script hiện tại đang sử dụng.
// ============================================================

app.post(
  '/jobs',
  (req, res) => {
    try {
      assertSecret(
        req.body.secret
      );

      if (
        !req.body.callbackUrl
      ) {
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

      if (
        !students.length
      ) {
        return res
          .status(400)
          .json({
            error:
              'Không có học viên hợp lệ'
          });
      }

      if (
        students.length > 20
      ) {
        return res
          .status(400)
          .json({
            error:
              'Chế độ bán tự động hỗ trợ tối đa 20 học viên/lần'
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
              req.body
                .delayMs ||
              1800
            )
          )
        );

      const job = {
        id,

        status:
          'queued',

        processed:
          0,

        errors:
          0,

        total:
          students.length,

        students,

        callbackUrl:
          req.body.callbackUrl,

        delayMs,

        createdAt:
          new Date().toISOString(),

        finishedAt:
          '',

        error:
          ''
      };

      jobs.set(
        id,
        job
      );

      console.log(
        `[POST /jobs] Tạo job ${id}`
      );

      console.log(
        `[POST /jobs] ${students.length} học viên`
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

      const statusCode =
        error.message ===
          'UNAUTHORIZED'
          ? 401
          : 500;

      return res
        .status(statusCode)
        .json({
          error:
            error.message ||
            String(error)
        });
    }
  }
);

// ============================================================
// GET /jobs/:id
//
// Frontend / Apps Script dùng để xem tiến độ.
// ============================================================

app.get(
  '/jobs/:id',
  (req, res) => {
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
      const statusCode =
        error.message ===
          'UNAUTHORIZED'
          ? 401
          : 500;

      return res
        .status(statusCode)
        .json({
          error:
            error.message ||
            String(error)
        });
    }
  }
);

// ============================================================
// DEBUG JOB LIST
//
// Không bắt buộc frontend sử dụng.
// Chỉ để kiểm tra worker.
// ============================================================

app.get(
  '/debug/jobs',
  (req, res) => {
    try {
      assertSecret(
        String(
          req.get(
            'X-Theory-Secret'
          ) || ''
        )
      );

      const list =
        Array.from(
          jobs.values()
        ).map(job => ({
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

          createdAt:
            job.createdAt,

          finishedAt:
            job.finishedAt ||
            ''
        }));

      res.json({
        count:
          list.length,

        jobs:
          list
      });
    } catch (error) {
      res
        .status(401)
        .json({
          error:
            error.message ||
            String(error)
        });
    }
  }
);

// ============================================================
// EXPRESS ERROR
// ============================================================

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      '[SERVER ERROR]',
      error.stack ||
      error.message
    );

    res
      .status(500)
      .json({
        error:
          error.message ||
          'Internal Server Error'
      });
  }
);

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